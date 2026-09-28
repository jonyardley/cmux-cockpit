// The exclusive lockfile the state loop's scripts share (docs/state-loop.md):
// the build lock in hook-build.ts, pr-poll.ts's run lock and state-url.ts's
// write lock. One copy, so a fix to taking, waiting for or retaking a lock
// reaches all three.

import { closeSync, mkdirSync, openSync, rmSync, statSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Takes the lockfile at `lock` if it is free. One older than `staleMs`
 * (longer than its holder could plausibly take) is a crashed run's and is
 * retaken. A holder that runs long keeps its lock fresh by touching it.
 */
export function tryTakeLock(lock: string, staleMs: number): boolean {
  mkdirSync(dirname(lock), { recursive: true });
  try {
    closeSync(openSync(lock, "wx"));
    return true;
  } catch {
    const age = Date.now() - (statSync(lock, { throwIfNoEntry: false })?.mtimeMs ?? Date.now());
    if (age <= staleMs) return false;
    try {
      rmSync(lock, { force: true });
      closeSync(openSync(lock, "wx"));
      return true;
    } catch {
      return false;
    }
  }
}

/** A synchronous pause, for callers that wait for a lock while holding one of their own. */
export const pauseSync = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

/**
 * Tries `take` until it succeeds or `maxWaitMs` has passed, pausing
 * `stepMs` between tries. One try at least, so a zero wait still takes a
 * free lock.
 */
export function waitForLock(
  take: () => boolean,
  maxWaitMs: number,
  pause: (ms: number) => void,
  stepMs: number,
): boolean {
  for (let waited = 0; ; waited += stepMs) {
    if (take()) return true;
    if (waited >= maxWaitMs) return false;
    pause(stepMs);
  }
}
