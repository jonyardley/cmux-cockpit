// Puts a chat's context and the plan's usage limits on its workspace's cmux
// description, for the agents panel's Context card. Claude Code hands both
// to the status line on every update, and nothing else gets them, so Jon's
// status line script starts this in the background with the same JSON on
// stdin:
//
//   printf '%s' "$payload" | node ~/.config/cmux/scripts/hooks/status-context.ts &
//
// The figures go in a bracketed tail after whatever the description holds
// (Jon's words or the chat's move, which report-move.ts keeps when it writes),
// so the panel reads them live and nothing is rebuilt. The status line runs
// many times a turn, so a figure is written only when a whole percent or a
// reset time moved since this workspace's last write, which a small file in
// the temp folder remembers. It never fails: every problem is a note on
// stderr and exit 0.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isId, isRecord, type SavedContext, savedContext, splitContext, withContext } from "../state-config.ts";
import { field } from "./gh-command.ts";
import { type DescriptionRead, readDescription, writeDescription } from "./report-move.ts";

const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const whole = (v: unknown): number | undefined => {
  const n = num(v);
  return n === undefined ? undefined : Math.round(n);
};
const clampPercent = (n: number | undefined): number | undefined =>
  n === undefined ? undefined : Math.max(0, Math.min(100, n));

// The tokens in the window now: the last call's input, cache writes and
// cache reads, which is what the used percentage is a share of.
function tokensNow(window: unknown): number | undefined {
  const usage = field(window, "current_usage");
  if (!isRecord(usage)) return whole(field(window, "total_input_tokens"));
  const parts = ["input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"].map(
    (k) => num(usage[k]) ?? 0,
  );
  return Math.round(parts.reduce((a, b) => a + b, 0));
}

// One plan limit's percent used and reset time, from rate_limits.<name>.
function limit(payload: unknown, name: string): { used: number | undefined; reset: number | undefined } {
  const l = field(field(payload, "rate_limits"), name);
  return { used: clampPercent(whole(field(l, "used_percentage"))), reset: whole(field(l, "resets_at")) };
}

/** The context the status line's JSON reports, at `now`; null when it has no used percentage. Exported for testing. */
export function contextFrom(payload: unknown, now: number): SavedContext | null {
  const window = field(payload, "context_window");
  const used = clampPercent(whole(field(window, "used_percentage")));
  if (used === undefined) return null;
  const hour = limit(payload, "five_hour");
  const week = limit(payload, "seven_day");
  return savedContext({
    epoch: now,
    used,
    tokens: tokensNow(window),
    size: whole(field(window, "context_window_size")),
    hour: hour.used,
    hourReset: hour.reset,
    week: week.used,
    weekReset: week.reset,
  });
}

/** True when `next` says something `last` did not: any figure but the time it was seen. Exported for testing. */
export function moved(last: SavedContext | null, next: SavedContext): boolean {
  if (last === null) return true;
  const { epoch: _a, tokens: _b, ...was } = last;
  const { epoch: _c, tokens: _d, ...now } = next;
  return JSON.stringify(was) !== JSON.stringify(now);
}

/** What report needs from the outside world, so a test can stand in for cmux and the temp file. */
export interface ContextDelivery {
  read: (wsId: string) => DescriptionRead;
  write: (wsId: string, description: string | null) => boolean;
  /** The context this workspace was last written with, or null. */
  last: (wsId: string) => SavedContext | null;
  remember: (wsId: string, c: SavedContext) => void;
}

/**
 * Writes the context onto the workspace's description, keeping what comes
 * before its tail, when a figure moved since the last write. Returns a note
 * for stderr, or null. Exported for testing.
 */
export function report(wsId: string, c: SavedContext, d: ContextDelivery): string | null {
  if (!moved(d.last(wsId), c)) return null;
  const current = d.read(wsId);
  if (!current.ok) return current.why === "unlisted" ? "cmux does not list the workspace" : "cmux did not answer";
  const { body } = splitContext(current.text);
  if (!d.write(wsId, withContext(body, c))) return "cmux refused the description";
  d.remember(wsId, c);
  return null;
}

const LAST_DIR = join(tmpdir(), "cmux-cockpit-context");

const REAL_DELIVERY: ContextDelivery = {
  read: readDescription,
  write: writeDescription,
  last: (wsId) => {
    try {
      return savedContext(JSON.parse(readFileSync(join(LAST_DIR, `${wsId}.json`), "utf8")));
    } catch {
      return null;
    }
  },
  remember: (wsId, c) => {
    try {
      mkdirSync(LAST_DIR, { recursive: true });
      writeFileSync(join(LAST_DIR, `${wsId}.json`), JSON.stringify(c));
    } catch {}
  },
};

if (import.meta.main) {
  let note: string | null = null;
  try {
    const wsId = process.env.CMUX_WORKSPACE_ID;
    const c = contextFrom(JSON.parse(readFileSync(0, "utf8")), Math.floor(Date.now() / 1000));
    // A workspace id names a file, so it must be a plain id with no path in it.
    if (wsId && isId(wsId) && !/[/\\]/.test(wsId) && c) note = report(wsId, c, REAL_DELIVERY);
  } catch (err) {
    note = err instanceof Error ? err.message : String(err);
  }
  if (note) console.error(`status-context: ${note}`);
}
