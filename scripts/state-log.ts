// The one log both state-set.ts and pr-poll.ts write to (docs/state-loop.md),
// so the path and the best-effort append behaviour live in one place instead
// of two copies drifting apart.

import { appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const LOG_PATH = join(homedir(), "Library", "Logs", "cmux-cockpit-state.log");

/** Appends one timestamped line. Best-effort: a logging failure never fails the caller. */
export function logLine(line: string): void {
  try {
    appendFileSync(LOG_PATH, `${new Date().toISOString()} ${line}\n`);
  } catch {
    // ignored: logging is best-effort
  }
}
