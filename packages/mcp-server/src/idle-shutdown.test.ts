/**
 * Unit tests for the backend's idle-shutdown tracker (src/idle-shutdown.ts).
 *
 * Regression cover for #86. The wrapper no longer kills the backend when its stdio
 * closes, so the backend must retire itself when no wrapper is connected — without
 * retiring while a client is still using it, which would be the worse bug.
 *
 * The timer is injected, so no real time passes and `process.exit` is never involved.
 */

import { describe, it, expect, vi } from 'vitest';
import { createIdleShutdownTracker } from './idle-shutdown.js';

/** Minimal controllable timer: lets a test fire the pending callback on demand. */
function fakeTimers() {
  let pending: (() => void) | null = null;
  let nextHandle = 1;
  const handles = new Set<number>();

  return {
    setTimer: (fn: () => void) => {
      pending = fn;
      const handle = nextHandle++;
      handles.add(handle);
      return handle;
    },
    clearTimer: (handle: any) => {
      handles.delete(handle);
      pending = null;
    },
    /** Fire the currently-armed callback, if any. */
    fire: () => {
      const fn = pending;
      pending = null;
      fn?.();
    },
    get armed() {
      return pending !== null;
    },
  };
}

function makeTracker(idleMs = 1000) {
  const timers = fakeTimers();
  const onShutdown = vi.fn();
  const tracker = createIdleShutdownTracker({
    idleMs,
    onShutdown,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });
  return { tracker, timers, onShutdown };
}

describe('idle shutdown tracker', () => {
  it('arms itself at startup so a backend nobody connects to does not live forever', () => {
    const { timers, onShutdown } = makeTracker();

    expect(timers.armed).toBe(true);

    timers.fire();
    expect(onShutdown).toHaveBeenCalledTimes(1);
  });

  it('disarms while a wrapper is connected', () => {
    const { tracker, timers, onShutdown } = makeTracker();

    tracker.onClientConnected();

    expect(tracker.activeClients).toBe(1);
    expect(timers.armed).toBe(false);
    expect(onShutdown).not.toHaveBeenCalled();
  });

  it('re-arms once the last wrapper disconnects, and then shuts down', () => {
    const { tracker, timers, onShutdown } = makeTracker();

    tracker.onClientConnected();
    tracker.onClientDisconnected();

    expect(tracker.activeClients).toBe(0);
    expect(timers.armed).toBe(true);

    timers.fire();
    expect(onShutdown).toHaveBeenCalledTimes(1);
  });

  it('does not shut down while another wrapper is still connected (#86)', () => {
    const { tracker, timers, onShutdown } = makeTracker();

    // Two clients — e.g. Claude Desktop and LM Studio sharing one backend.
    tracker.onClientConnected();
    tracker.onClientConnected();
    expect(tracker.activeClients).toBe(2);

    // One of them goes away; the other is still working.
    tracker.onClientDisconnected();

    expect(tracker.activeClients).toBe(1);
    expect(timers.armed).toBe(false);
    expect(onShutdown).not.toHaveBeenCalled();
  });

  it('does not shut down if a wrapper reconnects before the callback runs', () => {
    const { tracker, timers, onShutdown } = makeTracker();

    tracker.onClientConnected();
    tracker.onClientDisconnected();
    expect(timers.armed).toBe(true);

    // Wrapper comes back in the gap between the timer firing and the callback.
    tracker.onClientConnected();
    timers.fire();

    expect(onShutdown).not.toHaveBeenCalled();
  });

  it('never lets the client count go negative on repeated disconnects', () => {
    const { tracker, onShutdown } = makeTracker();

    tracker.onClientConnected();
    tracker.onClientDisconnected();
    tracker.onClientDisconnected();

    expect(tracker.activeClients).toBe(0);

    // A later connect must still disarm correctly rather than needing to climb
    // back out of a negative count.
    tracker.onClientConnected();
    expect(tracker.activeClients).toBe(1);
    expect(onShutdown).not.toHaveBeenCalled();
  });

  it('cancel() stops the tracker from firing', () => {
    const { tracker, timers, onShutdown } = makeTracker();

    tracker.cancel();
    expect(timers.armed).toBe(false);

    timers.fire();
    expect(onShutdown).not.toHaveBeenCalled();
  });
});
