import { Logger } from './logger.js';
import { Config } from './config.js';
import { FoundryConnector } from './foundry-connector.js';

export interface FoundryQuery {
  method: string;
  data?: any;
}

export interface FoundryResponse {
  success: boolean;
  data?: any;
  error?: string;
}

/**
 * How long a query will wait for the Foundry module to (re)connect before giving
 * up. Short on purpose: this only costs anything when we are already disconnected,
 * and a tool call that is going to fail should fail quickly rather than hang.
 *
 * Exists for #86. A client that closes stdio between prompts (LM Studio does) can
 * leave a freshly started backend listening before the module has reconnected, so
 * the very first tool call raced the reconnect and failed outright. Claude Desktop
 * holds stdio open for the whole session, which is why it never showed this.
 */
const MODULE_RECONNECT_GRACE_MS = 5000;

/** How often to re-check the connection while inside that grace period. */
const MODULE_RECONNECT_POLL_MS = 100;

export class FoundryClient {
  private logger: Logger;
  private config: Config['foundry'];
  private connector: FoundryConnector;

  constructor(config: Config['foundry'], logger: Logger) {
    this.config = config;
    this.logger = logger.child({ component: 'FoundryClient' });

    // Initialize the socket connector
    this.connector = new FoundryConnector({
      config: this.config,
      logger: this.logger,
    });
  }

  async connect(): Promise<void> {
    this.logger.info('Starting Foundry connector socket.io server');

    try {
      // Start the socket.io server that Foundry will connect to
      await this.connector.start();
      this.logger.info('Foundry connector started, waiting for module connection...');
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown connection error';
      this.logger.error('Failed to start Foundry connector', { error: errorMessage });
      throw new Error(`Failed to start Foundry connector: ${errorMessage}`);
    }
  }

  disconnect(): void {
    this.logger.info('Stopping Foundry connector...');
    this.connector.stop().catch(error => {
      this.logger.error('Error stopping connector', error);
    });
  }

  getConnectionType(): 'websocket' | 'webrtc' | null {
    return this.connector.getConnectionType();
  }

  /**
   * Resolve once the module is connected, or false if the grace period elapses.
   * Returns immediately when already connected, so the common path is unchanged.
   */
  private async waitForModule(timeoutMs: number = MODULE_RECONNECT_GRACE_MS): Promise<boolean> {
    if (this.connector.isConnected()) return true;

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, MODULE_RECONNECT_POLL_MS));
      if (this.connector.isConnected()) return true;
    }

    return this.connector.isConnected();
  }

  async query(method: string, data?: any): Promise<any> {
    if (!this.connector.isConnected()) {
      // Give the module a brief chance to (re)connect rather than failing the
      // first call outright — see MODULE_RECONNECT_GRACE_MS (#86).
      this.logger.debug('Module not connected, waiting briefly before query', { method });

      if (!(await this.waitForModule())) {
        throw new Error(
          'Foundry VTT module not connected. Please ensure Foundry is running and the MCP Bridge module is enabled.'
        );
      }

      this.logger.info('Module connected after brief wait, proceeding with query', { method });
    }

    this.logger.debug('Sending query to Foundry module', { method, data });

    try {
      const result = await this.connector.query(method, data);
      this.logger.debug('Query successful', { method, hasResult: !!result });
      return result;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown query error';
      this.logger.error('Query failed', { method, error: errorMessage });
      throw new Error(`Query ${method} failed: ${errorMessage}`);
    }
  }

  ping(): Promise<any> {
    return this.query('foundry-mcp-bridge.ping');
  }

  getConnectionInfo(): any {
    return this.connector.getConnectionInfo();
  }

  getConnectionState(): string {
    return this.connector.isConnected() ? 'connected' : 'disconnected';
  }

  isReady(): boolean {
    return this.connector.isConnected();
  }

  sendMessage(message: any): void {
    this.logger.debug('Sending message to Foundry', {
      type: message.type,
      requestId: message.requestId,
    });
    this.connector.sendToFoundry(message);
  }

  broadcastMessage(message: any): void {
    this.logger.debug('Broadcasting message to Foundry', { type: message.type });
    this.connector.broadcastMessage(message);
  }

  isConnected(): boolean {
    return this.connector.isConnected();
  }
}
