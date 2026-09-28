// The one log both state-set.ts and pr-poll.ts write to (docs/state-loop.md),
// so the path and the best-effort append behaviour live in one place instead
// of two copies drifting apart.

import { appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** The log under a given home folder; npm run doctor reads it under an injected one in tests. */
export const logPathFor = (home: string): string => join(home, "Library", "Logs", "cmux-cockpit-state.log");

export const LOG_PATH = logPathFor(homedir());

/** Appends one timestamped line. Best-effort: a logging failure never fails the caller. */
export function logLine(line: string): void {
  try {
    appendFileSync(LOG_PATH, `${new Date().toISOString()} ${line}\n`);
  } catch {
    // ignored: logging is best-effort
  }
}
