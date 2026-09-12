/**
 * Idle-shutdown tracking for the singleton backend (#86).
 *
 * Wrappers used to kill the backend when their stdio closed. Because the backend
 * is shared by every client, that stole the Foundry connection from anyone else
 * still using it — whichever wrapper happened to spawn it held a veto over the
 * rest. A client that closes stdio between prompts (LM Studio) therefore tore the
 * connection down on every turn.
 *
 * The wrapper no longer kills anything, so the backend has to retire itself
 * instead: once no wrapper has been connected for `idleMs`, it shuts down and
 * releases its lock.
 *
 * Kept free of sockets, timers-by-default and `process.exit` so it can be unit
 * tested — the timer and the shutdown action are both injected, mirroring how
 * `lock.ts` keeps its process/filesystem calls injectable.
 */

export interface IdleShutdownOptions {
  /** How long with zero connected wrappers before shutting down. */
  idleMs: number;
  /** What to do when that period elapses. */
  onShutdown: () => void;
  /** Injectable for tests; defaults to the global timer functions. */
  setTimer?: (fn: () => void, ms: number) => any;
  clearTimer?: (handle: any) => void;
}

export interface IdleShutdownTracker {
  /** Call when a wrapper connects to the control channel. */
  onClientConnected(): void;
  /** Call when a wrapper disconnects. Safe to call more than once per client. */
  onClientDisconnected(): void;
  /** Number of wrappers currently connected. */
  readonly activeClients: number;
  /** Whether the shutdown timer is currently armed. */
  readonly isArmed: boolean;
  /** Stop tracking entirely (used on explicit shutdown paths). */
  cancel(): void;
}

export function createIdleShutdownTracker(options: IdleShutdownOptions): IdleShutdownTracker {
  const setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = options.clearTimer ?? ((handle: any) => clearTimeout(handle));

  let activeClients = 0;
  let timer: any = null;

  const disarm = () => {
    if (timer !== null) {
      clearTimer(timer);
      timer = null;
    }
  };

  const arm = () => {
    disarm();
    timer = setTimer(() => {
      timer = null;
      // Re-check rather than trusting the timer: a wrapper may have reconnected
      // between the timer firing and this callback running.
      if (activeClients > 0) return;
      options.onShutdown();
    }, options.idleMs);
    // Never let the idle timer itself keep the process alive.
    timer?.unref?.();
  };

  // Armed from the start, not just after the first disconnect — otherwise a
  // backend that nobody ever connects to would live forever.
  arm();

  return {
    onClientConnected() {
      activeClients++;
      disarm();
    },

    onClientDisconnected() {
      activeClients = Math.max(0, activeClients - 1);
      if (activeClients === 0) arm();
    },

    get activeClients() {
      return activeClients;
    },

    get isArmed() {
      return timer !== null;
    },

    cancel: disarm,
  };
}
