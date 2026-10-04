// Saves the "Your move" line a chat ends its turn on, so the cockpit's card
// can quote what the chat wants from Jon. cmux keeps only the first 240
// characters of a message, and Jon's chats put that line last, so the
// sidebar never sees it without this hook.
//
// Run by scripts/hooks/dispatch.ts on Stop, once per turn. It takes the turn's final
// reply from the event's last_assistant_message, or else the main-chat
// reply that ends the transcript's tail, read once more after RETRY_MS when
// no reply ends it yet (Stop can fire before the reply is flushed). The line
// goes, with the count of numbered decisions the reply laid out and the
// options it leaned to, into the workspace's cmux description, which the
// sidebar reads live, so a turn end redraws nothing. Only when cmux refuses
// it is the move saved in config/state.json's `moves` map instead, which
// rebuilds the sidebars. A turn with no move line leaves the description
// alone (it may be Jon's own) and drops any saved move. The sidebar
// shows a move only while no prompt has come since it was saved (cmux's
// latestAt, src/shared/move.ts), so nothing here has to clear a stale one.
//
// A final reply with neither label would read as Jon's turn once the idle
// nudge lands, even when the chat is waiting on its own background work. So
// in an interactive chat inside cmux, such a turn is sent back once for the
// line (Claude Code's block decision on stdout, which dispatch.ts passes on
// for this script alone), and nothing is saved until the turn really ends.
// It never fails the hook: every problem is a note on stderr and exit 0.

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { scheduleBuild } from "../hook-build.ts";
import { cleanMove, isId, MAX_DECISIONS, moveDescription, type SavedMove, validateState } from "../state-config.ts";
import { readApplyWrite } from "../state-url.ts";
import { field } from "./gh-command.ts";
import { readTail, replyFrom, sleep } from "./transcript.ts";

// The line's label as Jon's rules write it, after any markdown the terminal
// would not show (a quote, bold, a list marker): "Your move:" when the turn
// waits on Jon, "Nothing for you:" when it waits on the agent. One word of
// drift may sit before the colon, inside the bold or after it ("Nothing for
// you yet:", "**Your move** now:"); only these words, so a sentence such as
// "Your move to main was blocked: ..." stays prose.
const DRIFT = String.raw`(?:\s+(?:yet|now|right now|for now|so far|at the moment|here|today))?`;
const MOVE_LINE = new RegExp(
  String.raw`^\s*(?:>\s*)?(?:[-*]\s+)?(?:\*\*|__)?(your move|nothing for you)${DRIFT}(?:\*\*|__)?${DRIFT}\s*:\s*(?:\*\*|__)?\s*(.+)$`,
  "i",
);
// A decision's heading: "**1. Where the card gets the line**", or the same
// as a bullet, "- **1. Where the card gets the line**".
const DECISION = /^\s*(?:[-*]\s+)?\*\*([1-9])[.)]\s/;
// An option under it: "> a) ...", "a) ...", "    a) ...", "> **a)** ...",
// or a bullet with a bold letter, "    - **a.** ...". A bullet needs the bold,
// so a situation bullet such as "- a) the card is cut" stays prose.
const OPTION = /^\s*(?:>\s*)?(?:[-*]\s+(?=\*\*|__))?(?:\*\*|__)?([a-z])[.)](?:\*\*|__)?\s/;
// The marker on the option the reply recommends: "**Lean.**", "(lean)",
// "**Recommended**". Only a marker: "keep the card lean" is prose.
const LEAN = /(?:\*\*|__)(?:lean|recommended)[.:]?(?:\*\*|__)|\((?:lean|recommended)\)/i;
// The same marker inside the option's bold label: "- **a. Recommended.** ...".
const LEAN_LABEL = /^\s*(?:>\s*)?(?:[-*]\s+)?(?:\*\*|__)[a-z][.)]\s+(?:lean|recommended)[.:]?(?:\*\*|__)/i;
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

/** The last move line in `text` outside a code fence, cleaned, with whether it asks nothing of Jon. */
function lastMove(text: string): { line: string; idle: boolean } | null {
  const lines = unfenced(text);
  for (let i = lines.length - 1; i >= 0; i--) {
    const hit = MOVE_LINE.exec(lines[i] ?? "");
    if (!hit?.[1] || !hit[2]) continue;
    const line = cleanMove(unmark(hit[2]));
    return line ? { line, idle: hit[1].toLowerCase() !== "your move" } : null;
  }
  return null;
}

/** The last "Your move" or "Nothing for you" line in `text` outside a code fence, cleaned, or null when there is none. */
export const moveLine = (text: string): string | null => lastMove(text)?.line ?? null;

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
    if ((LEAN.test(line) || LEAN_LABEL.test(line)) && !leans.some((l) => l.startsWith(current)))
      leans.push(current + o);
  }
  return { count: Math.min(seen.size, MAX_DECISIONS), leans: leans.join(" ") };
}

/** What the hook saves for a reply, or null when the reply has no move line. */
export function moveFrom(text: string, now: number, session?: string): SavedMove | null {
  const found = lastMove(text);
  if (!found) return null;
  const { count, leans } = decisionsIn(text);
  return {
    text: found.line,
    epoch: now,
    ...(session ? { session } : {}),
    ...(count ? { decisions: count } : {}),
    ...(leans ? { leans } : {}),
    ...(found.idle ? { idle: true } : {}),
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

/** What the chat is told when its turn is sent back. */
export const SEND_BACK_REASON =
  "Your reply has no closing line the cmux sidebar can read. Reply with only that line: " +
  '"Your move: <what Jon does next>" when something waits on him, or ' +
  '"Nothing for you: <what is running and what he hears next>" when the turn waits on your own work.';

/**
 * Whether to send the turn back for its closing line: only in an interactive
 * chat (`attended`), never twice in a row (stop_hook_active), and only when
 * the reply has neither label. A reply that lays out decisions is left alone:
 * it waits on Jon whatever it ends on, and a one-line retry would lose its
 * decisions and leans. No reply yet (not flushed, or an empty turn) is left
 * alone too: there is nothing to judge.
 */
export function shouldSendBack(event: unknown, reply: string, attended: boolean): boolean {
  if (!attended || field(event, "stop_hook_active") === true) return false;
  return !!reply.trim() && lastMove(reply) === null && decisionsIn(reply).count === 0;
}

interface Outcome {
  note: string | null;
  sendBack: boolean;
}

// Records the turn's move, or sends the turn back without saving anything,
// since the turn goes on. `now` is the hook's entry time, taken before
// finalReply may sleep, so a prompt that lands during that sleep is judged
// newer than the move.
function record(event: unknown, wsId: string | undefined, now: number, attended: boolean): Outcome {
  const none = { note: null, sendBack: false };
  if (!wsId || !isId(wsId) || field(event, "hook_event_name") !== "Stop") return none;
  const raw = field(event, "session_id");
  const session = typeof raw === "string" && isId(raw) ? raw : undefined;
  const reply = finalReply(event);
  if (shouldSendBack(event, reply, attended)) return { note: null, sendBack: true };
  return { note: deliver(wsId, moveFrom(reply, now, session), REAL_DELIVERY), sendBack: false };
}

/** Where a move goes: cmux's description, else the saved map and a rebuild. */
export interface Delivery {
  /** Sets the workspace's description; false when cmux refused it. */
  describe: (wsId: string, description: string) => boolean;
  hasSaved: (wsId: string) => boolean;
  save: (wsId: string, move: SavedMove | null) => { ok: true; changed: boolean } | { ok: false; error: string };
  build: () => void;
}

function cmuxDescribe(wsId: string, description: string): boolean {
  const bin = process.env.CMUX_CLAUDE_HOOK_CMUX_BIN || "cmux";
  const args = ["workspace-action", "--action", "set-description", "--workspace", wsId, "--description", description];
  return spawnSync(bin, args, { timeout: 5000, env: { ...process.env, CMUX_QUIET: "1" } }).status === 0;
}

const REAL_DELIVERY: Delivery = {
  describe: cmuxDescribe,
  hasSaved,
  save: (wsId, move) => readApplyWrite(STATE_PATH, `moves.${wsId}`, move ? JSON.stringify(move) : null),
  build: () => scheduleBuild("report-move"),
};

/**
 * Hands a turn's move to the cockpit, or drops a saved one when the turn
 * had none. The description comes first, since cmux sends it to the sidebar
 * live and nothing is rebuilt; the saved map, and the rebuild it costs, only
 * when cmux refused it. Returns a note for stderr, or null. Exported for testing.
 */
export function deliver(wsId: string, move: SavedMove | null, d: Delivery): string | null {
  if (move && d.describe(wsId, moveDescription(move))) return null;
  if (!move && !d.hasSaved(wsId)) return null;
  const result = d.save(wsId, move);
  if (!result.ok) return result.error;
  if (result.changed) d.build();
  return null;
}

if (import.meta.main) {
  const now = Math.floor(Date.now() / 1000);
  // "cli" is an interactive chat; a headless run (claude -p, the SDK) names
  // another entry point and must end on the output its caller asked for.
  const attended = process.env.CLAUDE_CODE_ENTRYPOINT === "cli";
  let out: Outcome;
  try {
    out = record(JSON.parse(readFileSync(0, "utf8")), process.env.CMUX_WORKSPACE_ID, now, attended);
  } catch (err) {
    out = { note: err instanceof Error ? err.message : String(err), sendBack: false };
  }
  if (out.note) console.error(`report-move: ${out.note}`);
  if (out.sendBack) console.log(JSON.stringify({ decision: "block", reason: SEND_BACK_REASON }));
}
