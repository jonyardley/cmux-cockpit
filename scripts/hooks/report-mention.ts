// Finds the paragraph where a chat first told Jon about a PR it opened, so
// the agents panel's peek card can quote it.
//
// Run as a Claude Code Stop hook, once per turn. report-pr.ts records which
// session opened each PR (config/state.json's `prOrigins`); this hook takes
// that session's origins that have no mention yet and reads the session's
// transcript for the first reply, from the create on, that names the PR by
// its link, `#N` or "PR N". The paragraph holding it is saved on one line,
// cut to MAX_MENTION, with the message's uuid. A saved mention never
// changes. With nothing pending for the session the transcript is not read,
// so an ordinary turn costs one small file read. It never fails the hook:
// every problem is a note on stderr and exit 0.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { scheduleBuild } from "../hook-build.ts";
import {
  cleanMention,
  isId,
  MAX_MENTION,
  type SavedMention,
  type SavedPrOrigin,
  type State,
  validateState,
} from "../state-config.ts";
import { writePrOrigins } from "../state-url.ts";
import { field } from "./gh-command.ts";

/** An origin older than this stops being looked for: a day. */
export const PENDING_MAX_AGE_S = 24 * 60 * 60;
// The create's own assistant message is stamped a moment before the hook
// records the origin; a reply is always later, so a little slack is enough.
const CLOCK_SLACK_S = 2;

const escapeRe = (s: string): string => s.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Matches the PR's link, "#N" or "PR N" / "PR #N", as whole numbers. */
export function mentionPattern(o: Pick<SavedPrOrigin, "url" | "number">): RegExp {
  const n = String(o.number);
  return new RegExp(`${escapeRe(o.url)}(?!\\d)|(?<![\\w&])#${n}(?!\\d)|\\bPR\\s+#?${n}(?!\\d)`, "i");
}

// Markdown the terminal would not show as characters: emphasis, code
// ticks, a link's target, and each line's list, quote or heading marker.
function plain(paragraph: string): string {
  return paragraph
    .split("\n")
    .map((line) => line.replace(/^\s*(?:[-*+]\s+|\d+[.)]\s+|>\s?|#{1,6}\s+)/, ""))
    .join(" ")
    .replaceAll(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replaceAll(/\*\*|__|`/g, "");
}

// Cut to MAX_MENTION by whole code points, ending in an ellipsis when cut.
function cut(text: string): string {
  const chars = [...text.replaceAll(/\s+/g, " ").trim()];
  if (chars.length <= MAX_MENTION) return chars.join("");
  return `${chars
    .slice(0, MAX_MENTION - 1)
    .join("")
    .trimEnd()}…`;
}

/** The first paragraph of `text` that `re` matches, as the card shows it; null when none does. */
export function paragraphWith(text: string, re: RegExp): string | null {
  const hit = text.split(/\n\s*\n/).find((p) => re.test(p));
  return hit === undefined ? null : cleanMention(cut(plain(hit)));
}

interface Reply {
  uuid: string;
  epoch: number;
  text: string;
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((b) => (field(b, "type") === "text" && typeof field(b, "text") === "string" ? [field(b, "text")] : []))
    .join("\n\n");
}

/** The main chat's reply in one transcript line, or null for anything else. */
export function replyFrom(line: string): Reply | null {
  // Most lines are tool results; skip them before paying for a parse.
  if (!line.includes('"assistant"')) return null;
  let v: unknown;
  try {
    v = JSON.parse(line);
  } catch {
    return null;
  }
  if (field(v, "type") !== "assistant" || field(v, "isSidechain") === true) return null;
  const uuid = field(v, "uuid");
  const epoch = Date.parse(String(field(v, "timestamp"))) / 1000;
  const text = textOf(field(field(v, "message"), "content"));
  if (typeof uuid !== "string" || !isId(uuid) || !Number.isFinite(epoch) || !text) return null;
  return { uuid, epoch: Math.floor(epoch), text };
}

/**
 * The first mention of each origin in a transcript's lines, keyed by URL.
 * An origin no reply names yet is left out.
 */
export function findMentions(lines: readonly string[], origins: readonly SavedPrOrigin[]): Map<string, SavedMention> {
  const found = new Map<string, SavedMention>();
  const wanted = origins.map((o) => ({ o, re: mentionPattern(o) }));
  for (const line of lines) {
    if (found.size === wanted.length) break;
    const reply = replyFrom(line);
    if (!reply) continue;
    for (const { o, re } of wanted) {
      if (found.has(o.url) || reply.epoch < o.epoch - CLOCK_SLACK_S) continue;
      const text = paragraphWith(reply.text, re);
      if (text) found.set(o.url, { text, message: reply.uuid, epoch: reply.epoch });
    }
  }
  return found;
}

/** The session's origins still waiting for a mention, at `now`. */
export function pendingFor(map: State["prOrigins"], session: string, now: number): SavedPrOrigin[] {
  return Object.values(map).filter((o) => o.session === session && !o.mention && now - o.epoch <= PENDING_MAX_AGE_S);
}

/** Sets each found mention on an origin that still has none. The input is not changed. */
export function applyMentions(map: State["prOrigins"], found: ReadonlyMap<string, SavedMention>): State["prOrigins"] {
  return Object.fromEntries(
    Object.entries(map).map(([url, o]) => {
      const m = found.get(url);
      return [url, m && !o.mention ? { ...o, mention: m } : o];
    }),
  );
}

const STATE_PATH = join(import.meta.dirname, "..", "..", "config", "state.json");

function readJson(path: string | number): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

// Records the event's mentions, returning a note for stderr when something went wrong.
function record(event: unknown): string | null {
  if (field(event, "hook_event_name") !== "Stop") return null;
  const session = field(event, "session_id");
  const transcript = field(event, "transcript_path");
  if (typeof session !== "string" || typeof transcript !== "string") return null;
  const now = Math.floor(Date.now() / 1000);
  const pending = existsSync(STATE_PATH) ? pendingFor(validateState(readJson(STATE_PATH)).prOrigins, session, now) : [];
  if (pending.length === 0) return null;
  let lines: string[];
  try {
    lines = readFileSync(transcript, "utf8").split("\n");
  } catch (err) {
    return `transcript: ${err instanceof Error ? err.message : String(err)}`;
  }
  const found = findMentions(lines, pending);
  if (found.size === 0) return null;
  const result = writePrOrigins(STATE_PATH, (map) => applyMentions(map, found));
  if (!result.ok) return result.error;
  if (result.changed) scheduleBuild("report-mention");
  return null;
}

if (import.meta.main) {
  let note: string | null;
  try {
    note = record(readJson(0));
  } catch (err) {
    note = err instanceof Error ? err.message : String(err);
  }
  if (note) console.error(`report-mention: ${note}`);
}
