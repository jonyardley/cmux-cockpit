// Saves the "Your move" line a chat ends its turn on, so the cockpit's card
// can quote what the chat wants from Jon. cmux keeps only the first 240
// characters of a message, and Jon's chats put that line last, so the
// sidebar never sees it without this hook.
//
// Run as a Claude Code Stop hook, once per turn. It takes the turn's final
// reply from the event's last_assistant_message, or else the main-chat
// reply that ends the transcript's tail, read once more after RETRY_MS when
// no reply ends it yet (Stop can fire before the reply is flushed). The line
// is saved per workspace in config/state.json's `moves` map with the count
// of numbered decisions the reply laid out and the options it leaned to.
// A turn with no move line drops the workspace's saved one. The sidebar
// shows a move only while no prompt has come since it was saved (cmux's
// latestAt, src/shared/move.ts), so nothing here has to clear a stale one. It
// never fails the hook: every problem is a note on stderr and exit 0.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { scheduleBuild } from "../hook-build.ts";
import { cleanMove, isId, MAX_DECISIONS, type SavedMove, validateState } from "../state-config.ts";
import { readApplyWrite } from "../state-url.ts";
import { field } from "./gh-command.ts";
import { readTail, replyFrom, sleep } from "./transcript.ts";

// The line's label as Jon's rules write it, after any markdown the terminal
// would not show (a quote, bold, a list marker).
const MOVE_LINE = /^\s*(?:>\s*)?(?:[-*]\s+)?(?:\*\*|__)?your move(?:\*\*|__)?\s*:\s*(?:\*\*|__)?\s*(.+)$/i;
// A decision's heading: "**1. Where the card gets the line**".
const DECISION = /^\s*\*\*([1-9])[.)]\s/;
// An option under it: "> a) ...", "a) ...", "    a) ...", "> **a)** ...".
const OPTION = /^\s*(?:>\s*)?(?:\*\*|__)?([a-z])[.)](?:\*\*|__)?\s/;
// The marker on the option the reply recommends: "**Lean.**", "(lean)",
// "**Recommended**". Only a marker: "keep the card lean" is prose.
const LEAN = /(?:\*\*|__)(?:lean|recommended)[.:]?(?:\*\*|__)|\((?:lean|recommended)\)/i;
// What ends a decision's options: a rule or a markdown heading.
const BREAK = /^\s*(?:-{3,}|\*{3,}|_{3,}|#{1,6}\s)/;
// A code fence's opening or closing line, in a quote or not.
const FENCE = /^\s*(?:>\s*)?(?:```|~~~)/;

const unmark = (s: string): string =>
  s
    .replaceAll(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replaceAll(/\*\*|__|`/g, "")
    .trim();

// The reply's lines outside code fences: a fenced handoff opener can hold a
// "Your move" line or a decision of its own that is not this reply's.
function unfenced(text: string): string[] {
  let inFence = false;
  return text.split("\n").filter((line) => {
    if (FENCE.test(line)) inFence = !inFence;
    else if (!inFence) return true;
    return false;
  });
}

/** The last "Your move" line in `text` outside a code fence, cleaned, or null when there is none. */
export function moveLine(text: string): string | null {
  const lines = unfenced(text);
  for (let i = lines.length - 1; i >= 0; i--) {
    const hit = MOVE_LINE.exec(lines[i] ?? "");
    if (hit?.[1]) return cleanMove(unmark(hit[1]));
  }
  return null;
}

/**
 * How many decisions a reply lays out, and the letter it leans to under each
 * ("1b 2a"). A heading counts only once a lettered option follows it, and a
 * rule or a markdown heading ends its options.
 */
export function decisionsIn(text: string): { count: number; leans: string } {
  const seen = new Set<string>();
  const leans: string[] = [];
  let current = "";
  for (const line of unfenced(text)) {
    const d = DECISION.exec(line)?.[1];
    if (d || BREAK.test(line)) {
      current = d ?? "";
      continue;
    }
    const o = OPTION.exec(line)?.[1];
    if (!current || !o) continue;
    seen.add(current);
    if (LEAN.test(line) && !leans.some((l) => l.startsWith(current))) leans.push(current + o);
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

// A main-chat user line: Jon's prompt (string content or a text block) or a
// tool's result (an array of tool_result blocks). A helper's lines and the
// meta lines Claude Code adds on its own are neither.
function isUserTurn(line: string): boolean {
  if (!line.includes('"user"')) return false;
  let v: unknown;
  try {
    v = JSON.parse(line);
  } catch {
    return false;
  }
  return field(v, "type") === "user" && field(v, "isSidechain") !== true && field(v, "isMeta") !== true;
}

/**
 * The reply that ends a transcript's lines, or "" when none ends it yet. A
 * turn ends on a reply with no tool call, so when a prompt or a tool result
 * comes after the last main-chat reply, that reply belongs to an earlier
 * turn or is text before a tool call: the final reply is not flushed yet.
 */
export function lastReply(lines: readonly string[]): string {
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i] ?? "";
    const reply = replyFrom(line);
    if (reply) return reply.text;
    if (isUserTurn(line)) return "";
  }
  return "";
}

const STATE_PATH = join(import.meta.dirname, "..", "..", "config", "state.json");
/** The most of a transcript read: the final reply is at its end. */
const TAIL_BYTES = 2 * 1024 * 1024;
// How long to wait for the final reply to be flushed before the one reread.
const RETRY_MS = 1500;

// The turn's final reply: the event's own copy when Claude Code sends one,
// else the transcript's, read again once if no reply ends it yet. A reply
// that is there but has no move line is final: there is nothing to wait for.
function finalReply(event: unknown): string {
  const given = field(event, "last_assistant_message");
  if (typeof given === "string" && given) return given;
  const transcript = field(event, "transcript_path");
  if (typeof transcript !== "string") return "";
  const first = lastReply(readTail(transcript, TAIL_BYTES));
  if (first) return first;
  sleep(RETRY_MS);
  return lastReply(readTail(transcript, TAIL_BYTES));
}

// Read without the lock: it only saves a write when there is nothing to drop.
function hasSaved(wsId: string): boolean {
  try {
    return Object.hasOwn(validateState(JSON.parse(readFileSync(STATE_PATH, "utf8"))).moves, wsId);
  } catch {
    return false;
  }
}

// Records the turn's move, returning a note for stderr when something went
// wrong. `now` is the hook's entry time, taken before finalReply may sleep,
// so a prompt that lands during that sleep is judged newer than the move.
function record(event: unknown, wsId: string | undefined, now: number): string | null {
  if (!wsId || !isId(wsId) || field(event, "hook_event_name") !== "Stop") return null;
  const raw = field(event, "session_id");
  const session = typeof raw === "string" && isId(raw) ? raw : undefined;
  const move = moveFrom(finalReply(event), now, session);
  if (!move && !hasSaved(wsId)) return null;
  const result = readApplyWrite(STATE_PATH, `moves.${wsId}`, move ? JSON.stringify(move) : null);
  if (!result.ok) return result.error;
  if (result.changed) scheduleBuild("report-move");
  return null;
}

if (import.meta.main) {
  const now = Math.floor(Date.now() / 1000);
  let note: string | null;
  try {
    note = record(JSON.parse(readFileSync(0, "utf8")), process.env.CMUX_WORKSPACE_ID, now);
  } catch (err) {
    note = err instanceof Error ? err.message : String(err);
  }
  if (note) console.error(`report-move: ${note}`);
}
