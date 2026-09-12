/**
 * FoundryClient query gating tests.
 *
 * Regression cover for #86: a client that closes stdio between prompts (LM Studio)
 * can leave a freshly started backend listening before the Foundry module has
 * reconnected. `query()` used to throw the moment it saw a disconnected connector,
 * so the first tool call after a reconnect lost that race and failed outright.
 * It now waits a short, bounded period first.
 *
 * The connector is replaced wholesale so these tests exercise the gating logic
 * with no sockets involved.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { FoundryClient } from './foundry-client.js';

function makeClient(connected: boolean) {
  const logger: any = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => logger,
  };

  const client = new FoundryClient({} as any, logger);

  const connector = {
    isConnected: vi.fn(() => connected),
    query: vi.fn(async () => ({ ok: true })),
  };
  (client as any).connector = connector;

  return { client, connector };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('FoundryClient.query connection gating', () => {
  it('queries immediately when the module is already connected', async () => {
    const { client, connector } = makeClient(true);

    await expect(client.query('foundry-mcp-bridge.ping')).resolves.toEqual({ ok: true });

    expect(connector.query).toHaveBeenCalledTimes(1);
    // Already connected: must not pay for any waiting.
    expect(connector.isConnected).toHaveBeenCalledTimes(1);
  });

  it('proceeds once the module connects during the grace period (#86)', async () => {
    const { client, connector } = makeClient(false);

    // Disconnected at first, then the module reconnects a moment later.
    connector.isConnected.mockReturnValueOnce(false).mockReturnValue(true);

    const pending = client.query('foundry-mcp-bridge.ping');
    await vi.advanceTimersByTimeAsync(200);

    await expect(pending).resolves.toEqual({ ok: true });
    expect(connector.query).toHaveBeenCalledTimes(1);
  });

  it('still reports the module as not connected once the grace period elapses', async () => {
    const { client, connector } = makeClient(false);

    const pending = client.query('foundry-mcp-bridge.ping');
    const assertion = expect(pending).rejects.toThrow(/module not connected/i);

    await vi.advanceTimersByTimeAsync(6000);
    await assertion;

    expect(connector.query).not.toHaveBeenCalled();
  });

  it('does not wait forever — gives up close to the grace period', async () => {
    const { client } = makeClient(false);

    const pending = client.query('foundry-mcp-bridge.ping');
    const assertion = expect(pending).rejects.toThrow(/module not connected/i);

    // Well short of the 5s grace period, it must not have resolved or rejected yet.
    await vi.advanceTimersByTimeAsync(1000);

    await vi.advanceTimersByTimeAsync(5000);
    await assertion;
  });
});
