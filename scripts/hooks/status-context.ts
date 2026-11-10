// Puts a chat's context and the plan's usage limits on its workspace's cmux
// description, for the agents panel's Context card. Claude Code hands both
// to the status line on every update, and nothing else gets them, so Jon's
// status line script starts this in the background with the same JSON on
// stdin, its output closed so the status line never waits for it:
//
//   (printf '%s' "$payload" | node ~/.config/cmux/scripts/hooks/status-context.ts >/dev/null 2>&1 &)
//
// The figures go in a bracketed tail after whatever the description holds
// (Jon's words or the chat's move, which report-move.ts keeps when it writes),
// so the panel reads them live and nothing is rebuilt. Both hooks hold the
// workspace's description lock while they read and write (description.ts);
// this one never waits for it, since the next update tries again. The status
// line runs many times a turn, so a chat writes only when a whole percent or
// a reset time moved since its own last write, which a small file per chat
// in the temp folder remembers, or every REFRESH_S anyway, which puts back a
// tail that was edited away. It never fails: every problem is a note on
// stderr and exit 0.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  isAccount,
  isId,
  isRecord,
  type SavedContext,
  savedContext,
  splitContext,
  withContext,
} from "../state-config.ts";
import { type DescriptionRead, readDescription, withDescriptionLock, writeDescription } from "./description.ts";
import { field } from "./gh-command.ts";

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

/**
 * The account a chat's Claude folder names, from CLAUDE_CONFIG_DIR:
 * "acme" for ~/.claude-acme; undefined for the main folder, unset, or a
 * name that is not plain characters. Each account has its own plan
 * limits, so the card says whose it shows. Exported for testing.
 */
export function accountOf(configDir: string | undefined): string | undefined {
  const found = /^\.claude-(.+)$/.exec(basename(configDir ?? "").toLowerCase());
  const name = found?.[1];
  return isAccount(name) ? name : undefined;
}

/** The context the status line's JSON reports, at `now`; null when it has no used percentage. Exported for testing. */
export function contextFrom(payload: unknown, now: number, account?: string): SavedContext | null {
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
    account,
  });
}

/** Seconds after which a chat writes its figures again even when none moved. */
export const REFRESH_S = 300;

/**
 * True when `next` is worth writing over `last`, this chat's last write: a
 * figure moved (the time seen and the exact token count do not count), or
 * REFRESH_S passed. Exported for testing.
 */
export function due(last: SavedContext | null, next: SavedContext): boolean {
  if (last === null || next.epoch - last.epoch >= REFRESH_S) return true;
  const { epoch: _a, tokens: _b, ...was } = last;
  const { epoch: _c, tokens: _d, ...now } = next;
  return JSON.stringify(was) !== JSON.stringify(now);
}

/** What report needs from the outside world, so a test can stand in for cmux and the temp file. */
export interface ContextDelivery {
  read: (wsId: string) => DescriptionRead;
  write: (wsId: string, description: string | null) => boolean;
  /** The context this chat last wrote, or null. */
  last: () => SavedContext | null;
  remember: (c: SavedContext) => void;
}

/**
 * Writes the context onto the workspace's description, keeping what comes
 * before its tail, when it is due. Returns a note for stderr, or null.
 * Exported for testing.
 */
export function report(wsId: string, c: SavedContext, d: ContextDelivery): string | null {
  if (!due(d.last(), c)) return null;
  const current = d.read(wsId);
  if (!current.ok) return current.why === "unlisted" ? "cmux does not list the workspace" : "cmux did not answer";
  const { body } = splitContext(current.text);
  if (!d.write(wsId, withContext(body, c))) return "cmux refused the description";
  d.remember(c);
  return null;
}

const LAST_DIR = join(tmpdir(), "cmux-cockpit-context");
// A file name from ids, so nothing but plain characters.
const safe = (s: string): string => s.replace(/[^A-Za-z0-9_-]/g, "_");

function delivery(file: string): ContextDelivery {
  return {
    read: readDescription,
    write: (wsId, description) => writeDescription("status-context", wsId, description),
    last: () => {
      try {
        return savedContext(JSON.parse(readFileSync(file, "utf8")));
      } catch {
        return null;
      }
    },
    remember: (c) => {
      try {
        mkdirSync(LAST_DIR, { recursive: true });
        writeFileSync(file, JSON.stringify(c));
      } catch {}
    },
  };
}

if (import.meta.main) {
  let note: string | null = null;
  try {
    const wsId = process.env.CMUX_WORKSPACE_ID;
    const payload: unknown = JSON.parse(readFileSync(0, "utf8"));
    const c = contextFrom(payload, Math.floor(Date.now() / 1000), accountOf(process.env.CLAUDE_CONFIG_DIR));
    const session = field(payload, "session_id");
    if (wsId && isId(wsId) && c) {
      const file = join(LAST_DIR, `${safe(wsId)}-${safe(typeof session === "string" ? session : "")}.json`);
      note = withDescriptionLock(
        wsId,
        0,
        () => report(wsId, c, delivery(file)),
        () => null,
      );
    }
  } catch (err) {
    note = err instanceof Error ? err.message : String(err);
  }
  if (note) console.error(`status-context: ${note}`);
}
