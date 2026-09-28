// Saves the "Your move" line a chat ends its turn on, so the cockpit's card
// can quote what the chat wants from Jon. cmux keeps only the first 240
// characters of a message, and Jon's chats put that line last, so the
// sidebar never sees it without this hook.
//
// Run as a Claude Code Stop hook, once per turn. It takes the turn's final
// reply from the event's last_assistant_message, or else the last main-chat
// reply in the transcript's tail, read once more after RETRY_MS when that
// reply has no move line yet (Stop can fire before it is flushed). The line
// is saved per workspace in config/state.json's `moves` map with the count
// of numbered decisions the reply laid out and the options it leaned to.
// A turn with no move line drops the workspace's saved one. The sidebar
// shows a move only while the agent's needs_input spell is no older than
// it (src/shared/move.ts), so nothing here has to clear a stale one. It
// never fails the hook: every problem is a note on stderr and exit 0.

import { closeSync, fstatSync, openSync, readFileSync, readSync } from "node:fs";
import { join } from "node:path";
import { scheduleBuild } from "../hook-build.ts";
import { cleanMove, isId, MAX_DECISIONS, type SavedMove, validateState } from "../state-config.ts";
import { readApplyWrite } from "../state-url.ts";
import { field } from "./gh-command.ts";
import { replyFrom, tailLines } from "./report-mention.ts";

// The line's label as Jon's rules write it, after any markdown the terminal
// would not show (a quote, bold, a list marker).
const MOVE_LINE = /^\s*(?:>\s*)?(?:[-*]\s+)?(?:\*\*|__)?your move(?:\*\*|__)?\s*:\s*(?:\*\*|__)?\s*(.+)$/i;
// A decision's heading: "**1. Where the card gets the line**".
const DECISION = /^\s*\*\*([1-9])[.)]\s/;
// An option under it: "> a) ...", "a) ...", "    a) ...".
const OPTION = /^\s*(?:>\s*)?([a-z])[.)]\s/;
// The option the reply recommends: "Lean", "(lean)", "Recommended".
const LEAN = /\blean\b|\brecommended\b/i;

const unmark = (s: string): string =>
  s
    .replaceAll(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replaceAll(/\*\*|__|`/g, "")
    .trim();

/** The last "Your move" line in `text`, cleaned, or null when there is none. */
export function moveLine(text: string): string | null {
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const hit = MOVE_LINE.exec(lines[i] ?? "");
    if (hit?.[1]) return cleanMove(unmark(hit[1]));
  }
  return null;
}

/** How many decisions a reply lays out, and the letter it leans to under each ("1b 2a"). */
export function decisionsIn(text: string): { count: number; leans: string } {
  const seen = new Set<string>();
  const leans: string[] = [];
  let current = "";
  for (const line of text.split("\n")) {
    const d = DECISION.exec(line)?.[1];
    if (d) {
      current = d;
      seen.add(d);
      continue;
    }
    const o = OPTION.exec(line)?.[1];
    if (current && o && LEAN.test(line) && !leans.some((l) => l.startsWith(current))) leans.push(current + o);
  }
  return { count: Math.min(seen.size, MAX_DECISIONS), leans: leans.join(" ") };
}

/** What the hook saves for a reply, or null when the reply has no move line. */
export function moveFrom(text: string, now: number, session?: string): SavedMove | null {
  const line = moveLine(text);
  if (!line) return null;
  const { count, leans } = decisionsIn(text);
  return {
    text: line,
    epoch: now,
    ...(session ? { session } : {}),
    ...(count ? { decisions: count } : {}),
    ...(leans ? { leans } : {}),
  };
}

/** The last main-chat reply's text in a transcript's lines, or "" when there is none. */
export function lastReply(lines: readonly string[]): string {
  for (let i = lines.length - 1; i >= 0; i--) {
    const reply = replyFrom(lines[i] ?? "");
    if (reply) return reply.text;
  }
  return "";
}

const STATE_PATH = join(import.meta.dirname, "..", "..", "config", "state.json");
/** The most of a transcript read: the final reply is at its end. */
const TAIL_BYTES = 2 * 1024 * 1024;
// How long to wait for the final reply to be flushed before the one reread.
const RETRY_MS = 1500;

function readTail(path: string): string[] {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - TAIL_BYTES);
    const buf = Buffer.alloc(size - start);
    const got = readSync(fd, buf, 0, buf.length, start);
    return tailLines(buf.subarray(0, got).toString("utf8"), start > 0);
  } finally {
    closeSync(fd);
  }
}

// A hook runs as its own short process, so blocking it is harmless.
const sleep = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

// The turn's final reply: the event's own copy when Claude Code sends one,
// else the transcript's, read again once if it has no move line yet.
function finalReply(event: unknown): string {
  const given = field(event, "last_assistant_message");
  if (typeof given === "string" && given) return given;
  const transcript = field(event, "transcript_path");
  if (typeof transcript !== "string") return "";
  const first = lastReply(readTail(transcript));
  if (moveLine(first)) return first;
  sleep(RETRY_MS);
  return lastReply(readTail(transcript));
}

// Read without the lock: it only saves a write when there is nothing to drop.
function hasSaved(wsId: string): boolean {
  try {
    return Object.hasOwn(validateState(JSON.parse(readFileSync(STATE_PATH, "utf8"))).moves, wsId);
  } catch {
    return false;
  }
}

// Records the turn's move, returning a note for stderr when something went wrong.
function record(event: unknown, wsId: string | undefined): string | null {
  if (!wsId || !isId(wsId) || field(event, "hook_event_name") !== "Stop") return null;
  const raw = field(event, "session_id");
  const session = typeof raw === "string" && isId(raw) ? raw : undefined;
  const move = moveFrom(finalReply(event), Math.floor(Date.now() / 1000), session);
  if (!move && !hasSaved(wsId)) return null;
  const result = readApplyWrite(STATE_PATH, `moves.${wsId}`, move ? JSON.stringify(move) : null);
  if (!result.ok) return result.error;
  if (result.changed) scheduleBuild("report-move");
  return null;
}

if (import.meta.main) {
  let note: string | null;
  try {
    note = record(JSON.parse(readFileSync(0, "utf8")), process.env.CMUX_WORKSPACE_ID);
  } catch (err) {
    note = err instanceof Error ? err.message : String(err);
  }
  if (note) console.error(`report-move: ${note}`);
}
