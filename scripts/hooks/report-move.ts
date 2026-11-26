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
// sidebar reads live, so a turn end redraws nothing. When the description
// holds Jon's own words, or cmux refuses or alters the write, the move is
// saved in config/state.json's `moves` map instead, which rebuilds the
// sidebars. A turn with no move line clears a move's description (never
// Jon's words) and drops any saved move. The sidebar
// shows a move only while no prompt has come since it was saved (cmux's
// latestAt, src/shared/move.ts), so nothing here has to clear a stale one.
//
// A final reply with neither label is never sent back for one: its last
// line is saved instead, marked unlabelled, and the card quotes it in grey,
// so Jon still sees what the chat ended on without paying for a second turn.
// When such a reply says "Nothing needed from you" and asks nothing else
// (quietness), its last line is saved as idle instead, so the turn
// end waits on the chat, as a "Nothing for you" line does. One that asks
// nothing without saying so is marked noAsk as well as unlabelled.
// It never fails the hook: every problem is a note on stderr and exit 0.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { scheduleBuild } from "../hook-build.ts";
import {
  cleanMove,
  isId,
  isMoveDescription,
  MAX_DECISIONS,
  moveDescription,
  type SavedContext,
  type SavedMove,
  splitContext,
  validateState,
  withContext,
} from "../state-config.ts";
import { logLine } from "../state-log.ts";
import { readApplyWrite } from "../state-url.ts";
import { type DescriptionRead, readDescription, withDescriptionLock, writeDescription } from "./description.ts";
import { field } from "./gh-command.ts";
import { readTail, replyFrom, sleep, TAIL_BYTES } from "./transcript.ts";

// The line's label as Jon's rules write it: "Your move:" when the turn
// waits on Jon, "Nothing for you:" when it waits on the agent. Markdown the
// terminal would not show may wrap it (a quote, a list or step marker, bold
// or italic with the colon inside or out), and "Jon, " may lead it. Nothing
// else counts: a reply without the exact label is quoted by its last line
// instead (lastLine), so loose wording costs nothing but the label. The
// text after the colon may be empty: a bare header over steps, which
// lastMove reads from the lines below.
const EMPH = String.raw`(?:\*\*|__|\*|_)?`;
const MOVE_LINE = new RegExp(
  String.raw`^\s*(?:>\s*)?(?:(?:\d+[.)]|[-*])\s+)?(?:jon,\s+)?${EMPH}(your move|nothing for you)${EMPH}\s*:\s*${EMPH}\s*(.*)$`,
  "i",
);
// Since 14 November 2026 Jon's rules end a reply on one bold ask, or say
// "Nothing needed from you." with no label (#418). A reply with neither
// label that says so at the start of a sentence may ask nothing of Jon: at
// a line's start, through the same markdown and "Jon, " the label allows,
// or straight after a sentence's closing mark and a space ("...for your
// word. Nothing needed from you."). Mid sentence ("There is nothing needed
// from you") it is prose. quietness reads the rest of the line.
const NOTHING_NEEDED = new RegExp(
  String.raw`(?:^\s*(?:>\s*)?(?:(?:\d+[.)]|[-*])\s+)?(?:jon,\s+)?|[.!?]${EMPH}\s+)${EMPH}nothing needed from you\b`,
  "gi",
);
// Words that leave Jon something after all, in the rest of the phrase's
// line: "Nothing needed from you except the merge", "...till you merge
// it", "...now; next I need your pick", "...before your go". Any of them
// waits on him. A bare "your" is none: "...while your other session
// finishes" asks nothing.
const QUALIFIED =
  /\b(?:except|beyond|but|besides|other than|apart from|aside from|unless|only|just|then|save for|needs?|please|(?:until|till|once|when|after|before|while) you|(?:before|until|on|with|for) your (?:go|yes|word|pick|call|answer|say))\b/i;
// The same words opening the line below: "Nothing needed from you", then
// "except the merge." on the next line.
const QUALIFIED_NEXT =
  /^\s*(?:>\s*)?(?:\*\*|__|\*|_)?(?:except|beyond|but|besides|other than|apart from|aside from|unless|only|then|save for|until|once|when|after|and|or)\b/i;
// A sentence break: a closing mark, then a space and more text. "v1.2" and
// "report-move.ts" hold no space after the dot, so they are no break.
const SENTENCE_BREAK = /[.!?][*_)"']*\s+\S/;
// A question: a question mark that ends a word, so a link's query string
// ("?page=2") is none.
const QUESTION = /\?[*_)"']*(?:\s|$)/;
// A title over choices or other waits: "**Decision**", "**Options**",
// "**Also waiting on you**", bold or as a heading.
const ASK_TITLE = /^\s*(?:#{1,6}\s+)?(?:\*\*|__)?(?:decision|options|also waiting on you)\b/i;
// A last line that opens with an ask verb, bold, italic or plain, after an
// optional quote, list or step marker and "Jon, ": "**Say go and I'll push
// the fix.**", "Paste that into the main checkout." The verbs are
// reply-check.py's ASK_VERB and a few more.
const ASK_VERB =
  "say|reply|pick|paste|merge|open|run|check|tell|choose|review|approve|label|send|answer|confirm|give|decide|look|type|let";
const ASK_LAST = new RegExp(
  String.raw`^\s*(?:>\s*)?(?:(?:\d+[.)]|[-*])\s+)?(?:jon,\s+)?(?:\*\*|__|\*|_)?(?:jon,\s+)?(?:${ASK_VERB})\b`,
  "i",
);
// The same verbs where an instruction would start: at the start of the
// text, or after a clause or sentence mark and a space, optionally after
// "you", "please", "then", "and" or "so". "Nothing needed from you yet;
// merge #419 when CI is green" asks after all. Mid clause the verb is no
// instruction, so "...until the pull request is ready to merge" and
// "...while the reviewers run" ask nothing.
const ASK_WORD = new RegExp(
  String.raw`(?:^\s*|[;,:.!?][*_)"']*\s+)(?:(?:you|please|then|and|so)\s+)?(?:${ASK_VERB})\b`,
  "i",
);
// A last line that opens "Nothing", bold, italic or plain, with the rest of
// the line after the word: asksAnything reads it as the phrase's line is
// read, so "**Nothing merges until you say go.**" still asks.
const NOTHING_LAST = /^\s*(?:>\s*)?(?:(?:\d+[.)]|[-*])\s+)?(?:jon,\s+)?(?:\*\*|__|\*|_)?(?:jon,\s+)?nothing\b(.*)$/i;
// A last line that opens on bold or italic: Jon's rules make that the ask,
// unless it opens "Nothing", which lastAsks reads first ("**Nothing to do
// until the screenshots arrive.**"). The text after the marker is no marker itself, so "**" is
// never read as "*" then "*Nothing".
const EMPHASIS_LAST =
  /^\s*(?:>\s*)?(?:(?:\d+[.)]|[-*])\s+)?(?:jon,\s+)?(?:\*\*|__|\*|_)(?!\s*(?:jon,\s+)?nothing\b)[^\s*_]/i;
// A list or step marker at the start of a line: "1.", "2)", "-", "*", ">".
const STEP_MARKER = /^\s*(?:>\s*)?(?:\d+[.)]|[-*])\s+/;
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

// The first non-blank line after a bare label header, as a step: marker and
// markdown stripped. A rule, a heading or a decision there is no step, so
// the header reads as empty rather than putting "---" on the card.
function stepAfter(lines: readonly string[], from: number): string {
  const next = lines.slice(from + 1).find((l) => l.trim() !== "");
  if (next === undefined || BREAK.test(next) || DECISION.test(next)) return "";
  return unmark(next.replace(STEP_MARKER, ""));
}

type Found = { line: string; idle: boolean };

// The move a label on line `i` holds: its text, else the first step below a
// bare header, else "" for a bare header with nothing under it.
function labelMove(hit: RegExpExecArray, lines: readonly string[], i: number): Found {
  const [, label = "", rest = ""] = hit;
  return { line: cleanMove(unmark(rest) || stepAfter(lines, i)) ?? "", idle: !/^your move/i.test(label) };
}

/**
 * The last labelled line in `text` outside a code fence, cleaned, with
 * whether it asks nothing of Jon; "bare" for a label with nothing under it,
 * which is no move but is no unlabelled reply either; null with no label.
 */
function lastMove(text: string): Found | "bare" | null {
  const lines = unfenced(text);
  for (let i = lines.length - 1; i >= 0; i--) {
    const hit = MOVE_LINE.exec(lines[i] ?? "");
    if (!hit) continue;
    const found = labelMove(hit, lines, i);
    return found.line ? found : "bare";
  }
  return null;
}

/** The last "Your move" or "Nothing for you" line in `text` outside a code fence, cleaned, or null when there is none. */
export function moveLine(text: string): string | null {
  const found = lastMove(text);
  return found === null || found === "bare" ? null : found.line;
}

// A table row: no line to quote on its own.
const TABLE_ROW = /^\s*\|/;
// A quote's marker, and italics around the whole line ("_Done._").
const QUOTE = /^\s*>\s?/;
const ITALIC = /^([*_])(.+)\1$/;

// Whether lastLine may quote a line: not blank, a rule, a heading or a
// table row.
const quotable = (l: string): boolean => l.trim() !== "" && !BREAK.test(l) && !TABLE_ROW.test(l);

// The reply's last line outside a code fence as written, skipping rules,
// headings and table rows.
const lastRawLine = (text: string): string | undefined => unfenced(text).reverse().find(quotable);

type Rest = { rest: string; next: string };

// The rest of the line after each sentence that starts "Nothing needed
// from you", with the line below it. A quoted line counts only as the
// reply's last line: a quote higher up repeats something said before.
function nothingNeededRests(lines: readonly string[]): Rest[] {
  let last = -1;
  lines.forEach((l, i) => {
    if (quotable(l)) last = i;
  });
  return lines.flatMap((line, i) => {
    if (QUOTE.test(line) && i !== last) return [];
    return [...line.matchAll(NOTHING_NEEDED)].map((m) => ({
      rest: line.slice(m.index + m[0].length),
      next: lines[i + 1] ?? "",
    }));
  });
}

// Whether the rest of a line after "Nothing" leaves Jon nothing: it ends
// its sentence and holds no qualifier and no ask verb.
const quietRest = (rest: string): boolean =>
  !SENTENCE_BREAK.test(rest) && !QUALIFIED.test(rest) && !ASK_WORD.test(rest);

// A phrase that leaves Jon nothing: the rest of its line is quiet, and the
// line below opens with no qualifier.
const unqualified = ({ rest, next }: Rest): boolean => quietRest(rest) && !QUALIFIED_NEXT.test(next);

// A task left with Jon in a "Nothing" last line: "**Nothing else is needed
// here. The email is still yours to send.**"
const YOURS = /\byours\b/i;
// Jon addressed anywhere: "Ready for your review", "A yes from you merges
// it". "Jon," opening a line is his name, never this.
const YOU = /\b(?:you|your|yours)\b/i;
const PHRASE = /nothing needed from you/gi;

// Whether the reply's last line asks: one that opens "Nothing" asks when the
// rest of it holds a qualifier, a task left as Jon's, or an ask verb where an
// instruction starts (a sentence break alone is none: "Nothing is running.
// Nothing needed from you."); any other asks when it opens with an ask verb
// or on bold or italic. Once the reply has said "Nothing needed from you"
// (`saidNothing`), a bold line that never addresses Jon is no ask: on 26
// November "**No action yet; I'll report when the pull request lands.**"
// closed such a reply and was saved as waiting. Any "you", qualifier or ask
// verb where an instruction starts still asks ("**Ready for your review.**").
function lastAsks(last: string, saidNothing: boolean): boolean {
  const nothing = NOTHING_LAST.exec(last);
  if (nothing) {
    const rest = nothing[1] ?? "";
    return QUALIFIED.test(rest) || YOURS.test(rest) || ASK_WORD.test(rest);
  }
  if (ASK_LAST.test(last)) return true;
  const plain = unmark(last).replaceAll(PHRASE, "");
  if (saidNothing && ASK_WORD.test(plain)) return true;
  if (!EMPHASIS_LAST.test(last)) return false;
  return !saidNothing || YOU.test(plain) || QUALIFIED.test(plain);
}

// Whether any line addresses Jon or tells him to act: "you" outside the
// "Nothing needed from you" phrase, or an ask verb where an instruction
// starts. A noAsk reply needs none, so only plain progress is held.
const addressesJon = (lines: readonly string[]): boolean =>
  lines.some((l) => {
    const plain = unmark(l.replace(STEP_MARKER, "").replace(QUOTE, "")).replaceAll(PHRASE, "");
    return YOU.test(plain) || ASK_WORD.test(plain);
  });

// Whether a reply asks Jon something however it is worded: a question, a
// decision or waiting title, decisions laid out, or a last line that asks.
function asksAnything(text: string, lines: readonly string[], saidNothing: boolean): boolean {
  if (lines.some((l) => QUESTION.test(l) || ASK_TITLE.test(l))) return true;
  if (decisionsIn(text).count > 0) return true;
  return lastAsks(lastRawLine(text) ?? "", saidNothing);
}

/**
 * How a reply with no label stands with Jon. "idle" when a sentence outside
 * a code fence starts "Nothing needed from you", every such sentence is
 * unqualified, and the reply asks nothing anywhere else. "noAsk" when it
 * never says so but asks nothing either and never addresses Jon: a progress
 * reply while the chat's subagents work, which the sidebars hold on Running
 * while they run.
 * Null when it asks. A real ask always wins: a false quiet hides it, a
 * false wait is only noise.
 */
function quietness(text: string): "idle" | "noAsk" | null {
  const lines = unfenced(text);
  const rests = nothingNeededRests(lines);
  if (!rests.every(unqualified)) return null;
  const said = rests.length > 0;
  if (asksAnything(text, lines, said)) return null;
  if (said) return "idle";
  return addressesJon(lines) ? null : "noAsk";
}

/**
 * A reply's last line outside a code fence, marker and markdown stripped,
 * skipping rules, headings and table rows: what the card quotes when the
 * reply has no label. Null when nothing is left.
 */
export function lastLine(text: string): string | null {
  const line = lastRawLine(text);
  if (line === undefined) return null;
  const plain = unmark(line.replace(STEP_MARKER, "").replace(QUOTE, ""));
  return cleanMove(plain.replace(ITALIC, "$2"));
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
    if ((LEAN.test(line) || LEAN_LABEL.test(line)) && !leans.some((l) => l.startsWith(current)))
      leans.push(current + o);
  }
  return { count: Math.min(seen.size, MAX_DECISIONS), leans: leans.join(" ") };
}

/**
 * What the hook saves for a reply: its labelled line, else, in an
 * interactive chat (`attended`), its last line, marked idle when the reply
 * says nothing is needed from Jon (quietness) and unlabelled
 * otherwise; null for a bare label, or a headless run (claude -p, the SDK)
 * with no label, whose output is no chat's move and must not replace one.
 */
export function moveFrom(text: string, now: number, session?: string, attended = true): SavedMove | null {
  const found = lastMove(text);
  if (found === "bare" || (found === null && !attended)) return null;
  const line = found?.line ?? lastLine(text);
  if (!line) return null;
  const { count, leans } = decisionsIn(text);
  const quiet = found === null ? quietness(text) : null;
  return {
    text: line,
    epoch: now,
    ...(session ? { session } : {}),
    ...(count ? { decisions: count } : {}),
    ...(leans ? { leans } : {}),
    ...(found?.idle || quiet === "idle" ? { idle: true } : {}),
    ...(found || quiet === "idle" ? {} : { unlabelled: true }),
    ...(quiet === "noAsk" ? { noAsk: true } : {}),
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

// Records the turn's move; a note for stderr, or null. `now` is the hook's
// entry time, taken before finalReply may sleep, so a prompt that lands
// during that sleep is judged newer than the move.
function record(event: unknown, wsId: string | undefined, now: number, attended: boolean): string | null {
  if (!wsId || !isId(wsId) || field(event, "hook_event_name") !== "Stop") return null;
  const raw = field(event, "session_id");
  const session = typeof raw === "string" && isId(raw) ? raw : undefined;
  const move = moveFrom(finalReply(event), now, session, attended);
  // The lock keeps the status line's context writer from putting back the
  // description it read before this move went in (description.ts). Waiting
  // out a stuck holder costs at most the wait, then the move goes ahead.
  return withDescriptionLock(
    wsId,
    3000,
    () => deliver(wsId, move, REAL_DELIVERY),
    () => deliver(wsId, move, REAL_DELIVERY),
  );
}

export interface Delivery {
  read: (wsId: string) => DescriptionRead;
  /** Sets the description, or clears it for null; false when cmux refused. */
  write: (wsId: string, description: string | null) => boolean;
  hasSaved: (wsId: string) => boolean;
  save: (wsId: string, move: SavedMove | null) => { ok: true; changed: boolean } | { ok: false; error: string };
  build: () => void;
  /** Says in the state log why a move went to the saved map, since a hook's stderr is not kept. */
  log: (line: string) => void;
}

const REAL_DELIVERY: Delivery = {
  read: readDescription,
  write: (wsId, description) => writeDescription("report-move", wsId, description),
  hasSaved,
  save: (wsId, move) => readApplyWrite(STATE_PATH, `moves.${wsId}`, move ? JSON.stringify(move) : null),
  build: () => scheduleBuild("report-move"),
  log: (line) => logLine(`report-move ${line}`),
};

// Asks again once when cmux does not answer, since a busy cmux's one missed
// answer would otherwise cost a rebuild of the agents panel. A workspace cmux
// does not list is not asked about again: the answer would be the same.
function readTwice(wsId: string, d: Delivery): DescriptionRead {
  const first = d.read(wsId);
  return !first.ok && first.why === "silent" ? d.read(wsId) : first;
}

// Why a read gave no description, for the state log; `what` names the read.
const unread = (r: { why: "unlisted" | "silent" }, what: string): string =>
  r.why === "unlisted" ? "cmux does not list the workspace" : `cmux did not answer the ${what}, twice`;

// The description with no body, keeping the context tail: null (clear it)
// when there is no context to keep.
const contextOnly = (context: SavedContext | null): string | null => (context ? withContext("", context) : null);

// Sets the move's description, keeping the context tail the status line
// wrote, then reads it back: a description cmux cut or changed would read
// as no move and show a broken tail, so the move is taken off again and the
// caller falls back to the saved map. Only the move's part is compared, as
// the status line may rewrite the context tail in between. The read-back is
// asked twice too, so one missed answer never clears a description that
// landed. Null when it landed, else why not.
function describeMove(wsId: string, move: SavedMove, context: SavedContext | null, d: Delivery): string | null {
  const body = moveDescription(move);
  if (!d.write(wsId, withContext(body, context))) return "cmux refused the description";
  const back = readTwice(wsId, d);
  if (back.ok && splitContext(back.text).body === body) return null;
  d.write(wsId, contextOnly(context));
  return back.ok ? "cmux changed the description" : unread(back, "read-back");
}

// Why a move cannot go in the description, or null when it went: the
// description holds Jon's words, cmux could not say what it holds, or
// describeMove's reason.
function described(wsId: string, move: SavedMove, d: Delivery): string | null {
  const current = readTwice(wsId, d);
  if (!current.ok) return unread(current, "read");
  const { body, context } = splitContext(current.text);
  if (body !== "" && !isMoveDescription(body)) return "the description holds other words";
  return describeMove(wsId, move, context, d);
}

// Saves (or drops, for null) the workspace's move in the saved map and
// rebuilds when that changed it; `why` is the reason a move went there, for
// the state log, which says so only once the save has run.
function save(wsId: string, move: SavedMove | null, d: Delivery, why?: string): string | null {
  const result = d.save(wsId, move);
  const id = wsId.slice(0, 8);
  if (!result.ok) {
    if (why) d.log(`could not save the move for ${id} (${why}): ${result.error}`);
    return result.error;
  }
  if (why) d.log(`saved the move for ${id}: ${why}`);
  if (result.changed) d.build();
  return null;
}

/**
 * Hands a turn's move to the cockpit, or retires the last one when the turn
 * had none. The description comes first, since cmux sends it to the sidebar
 * live and nothing is rebuilt, but only while it is empty or already holds a
 * move: Jon's own words are never overwritten. Otherwise, or when cmux
 * refuses or alters it, the move goes to the saved map, at the cost of a
 * rebuild, and the state log says why. A turn with no move reads the
 * description once: it only gates an optional clear. Returns a note for
 * stderr, or null. Exported for testing.
 */
export function deliver(wsId: string, move: SavedMove | null, d: Delivery): string | null {
  if (move) {
    const why = described(wsId, move, d);
    return why === null ? null : save(wsId, move, d, why);
  }
  const current = d.read(wsId);
  if (current.ok && isMoveDescription(current.text)) d.write(wsId, contextOnly(splitContext(current.text).context));
  return d.hasSaved(wsId) ? save(wsId, null, d) : null;
}

if (import.meta.main) {
  const now = Math.floor(Date.now() / 1000);
  // "cli" is an interactive chat; a headless run names another entry point.
  const attended = process.env.CLAUDE_CODE_ENTRYPOINT === "cli";
  let note: string | null;
  try {
    note = record(JSON.parse(readFileSync(0, "utf8")), process.env.CMUX_WORKSPACE_ID, now, attended);
  } catch (err) {
    note = err instanceof Error ? err.message : String(err);
  }
  if (note) console.error(`report-move: ${note}`);
}
