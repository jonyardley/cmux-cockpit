// The one log state-set.ts, pr-poll.ts and build.ts write to (docs/state-loop.md),
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

/** What one build carried: the tags of the writes it coalesced, and the
 * top-level state keys that differ from the state the last build baked. */
export interface RedrawCause {
  tags: readonly string[];
  /** null when the state file could not be read, so no keys can be named. */
  changed: readonly string[] | null;
}

// Each tag once, in first-seen order, with a count when it wrote more than
// once: "report-subagent x3, report-move".
function tally(tags: readonly string[]): string {
  const counts = new Map<string, number>();
  for (const tag of tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  return [...counts].map(([tag, n]) => (n > 1 ? `${tag} x${n}` : tag)).join(", ");
}

/** One build's log line: the sidebars it rewrote, each a full redraw in
 * cmux, then, given a cause, what wrote and which state keys changed. */
export function redrawLine(written: readonly string[], cause?: RedrawCause): string {
  const line = `build: redrew ${written.length ? written.join(", ") : "nothing"}`;
  if (!cause) return line;
  const writes = cause.tags.length ? tally(cause.tags) : "none";
  const changed = cause.changed === null ? "state unreadable" : cause.changed.join(", ") || "none";
  return `${line}; writes ${writes}; changed ${changed}`;
}
