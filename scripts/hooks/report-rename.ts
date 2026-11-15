// Carries a Claude Code `/rename` over to the cmux workspace, so the
// sidebar row shows the name Jon gave the session. `/rename` only writes a
// custom-title line into the transcript and fires no hook, and cmux never
// reads it, so without this the row keeps its old name.
//
// Run by scripts/hooks/dispatch.ts on UserPromptSubmit, Stop and
// SessionStart: the name moves when the turn a rename was made in finishes,
// on the next message after a rename made while idle or in a turn cut short
// (Esc or an error runs no Stop hook), or when a renamed session is resumed.
// A small file per session and workspace under config/renames/ holds how far
// into the transcript the hook has read, the latest rename seen there and
// the last one it handled, so each run reads only what was added since, and
// a name Jon later gives the workspace in cmux by hand is not put back on
// every run. A name that matches a cmux group's name
// is skipped: the cockpit takes a workspace titled after its group for the
// group's generated placeholder (isGeneratedAnchor in src/shared/anchors.ts)
// and would hide it. It never fails the hook: every problem is a note on
// stderr and exit 0.
//
// Two prompts rename the workspace at once, on UserPromptSubmit. `/ws
// <name>` renames it and is blocked, so it never reaches the model and
// costs no turn; its name keeps the workspace's issue number unless it
// brings its own. A session's first real prompt that names an issue puts
// the number at the front of a workspace name that has none ("#123 Fix
// reload"); no later prompt does, so the name settles once. cmux's own
// auto-naming is a setting Jon turns off; these are the only renames left.
//
// The same read also names the session for the agents panel: the latest
// `/rename`, else its first real prompt (slash commands, shell escapes and
// harness text skipped). cmux's own agent title is the first message, which
// it cannot read for a ~/.claude-personal session and filters to nothing
// after a `/clear`, so rows fell back to "Claude 1", "Claude 2". The name
// goes into config/state.json's `names` map under the session id, which is
// the agent's id in cmux, and the build bakes it in (src/agents/team.ts).

import { closeSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readable } from "../../src/shared/text.ts";
import { scheduleBuild } from "../hook-build.ts";
import { cleanLabel, type SavedName } from "../state-config.ts";
import { writeNames } from "../state-url.ts";
import { cmux } from "./cmux-cli.ts";
import { field } from "./gh-command.ts";

// A new stretch of transcript is normally a few kilobytes; this bounds the
// first read of a long one, whose rename can sit anywhere in it.
const MAX_READ_BYTES = 64 * 1024 * 1024;
// When that read skipped ahead, the first prompt is looked for in this much
// of what it skipped: it sits near the top of the transcript.
const HEAD_BYTES = 1024 * 1024;
const STAMP_DIR = join(import.meta.dirname, "..", "..", "config", "renames");
const STATE_PATH = join(import.meta.dirname, "..", "..", "config", "state.json");
const ID = /^[\w-]{1,128}$/;

/** The latest name `/rename` gave the session, trimmed, or null when it was never renamed. */
export function latestTitle(lines: string[]): string | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i] ?? "";
    // Most lines are messages and tool results; skip them before a parse.
    if (!line.includes('"custom-title"')) continue;
    let v: unknown;
    try {
      v = JSON.parse(line);
    } catch {
      continue;
    }
    const title = field(v, "customTitle");
    if (field(v, "type") === "custom-title" && typeof title === "string" && title.trim()) return title.trim();
  }
  return null;
}

/**
 * What Jon typed in a user message's text, cleaned as a label, or null when
 * the agents panel would not show it. The panel's own readable() drops
 * harness text Claude Code wraps in tags (a slash command, a shell escape,
 * a system reminder), image and pasted-text markers, and anything without
 * words, so a prompt it would blank is never kept in place of a later one.
 */
export function promptText(text: string): string | null {
  const words = readable(text);
  return words.startsWith("[Request interrupted") ? null : cleanLabel(words);
}

// A user message's text, or null for a tool result or anything else.
function userText(v: unknown): string | null {
  const flags = ["isSidechain", "isMeta", "isCompactSummary"];
  if (field(v, "type") !== "user" || flags.some((f) => field(v, f) === true)) return null;
  const content = field(field(v, "message"), "content");
  if (typeof content === "string") return content;
  if (!Array.isArray(content) || content.some((b) => field(b, "type") === "tool_result")) return null;
  return content.flatMap((b) => (field(b, "type") === "text" ? [String(field(b, "text"))] : [])).join(" ");
}

/** The session's first real prompt, cleaned, or null when these lines hold none. */
export function firstPrompt(lines: string[]): string | null {
  for (const line of lines) {
    // Most lines are replies and tool calls; skip them before a parse.
    if (!line.includes('"user"')) continue;
    let v: unknown;
    try {
      v = JSON.parse(line);
    } catch {
      continue;
    }
    const text = userText(v);
    const prompt = text === null ? null : promptText(text);
    if (prompt) return prompt;
  }
  return null;
}

/** The name the agents panel shows: the latest `/rename`, else the first prompt. */
export function sessionName(title: string | null, prompt: string | null): SavedName | null {
  const renamed = title === null ? null : cleanLabel(title);
  if (renamed) return { name: renamed, from: "title" };
  return prompt ? { name: prompt, from: "prompt" } : null;
}

/** `names` with the session's entry set, moved last so the cap drops the oldest first. */
export function withName(
  names: Record<string, SavedName>,
  session: string,
  name: SavedName,
): Record<string, SavedName> {
  const rest = Object.fromEntries(Object.entries(names).filter(([id]) => id !== session));
  return { ...rest, [session]: name };
}

// "#123", "issue 123", "issue #123" or "issues 123", not inside a word,
// a link or an entity; or a GitHub issue link.
const ISSUE = /(?<![\w/#&])(?:issues?\s+#?(\d+)|#(\d+))\b|\/issues\/(\d+)\b/gi;
// What comes right before a pull request's number: "PR #12", "PRs 12",
// "pull request 12".
const PR_BEFORE = /\b(?:prs?|pull requests?)\s*$/i;
// What joins numbers in a list: "#12, #13 and #14".
const LIST_JOIN = /^[\s,]*(?:and|or|&)?\s*$/i;
// A colour, not an issue: "#222222", "#22222280".
const COLOUR = /^#(?:\d{6}|\d{8})$/;

/**
 * The first issue a prompt names, or null when it names none. A pull
 * request's number is not one, nor is a number listed straight after one,
 * nor a colour written in digits.
 */
export function issueIn(prompt: string): number | null {
  let prEnd = -1;
  for (const m of prompt.matchAll(ISSUE)) {
    const listedAfterPr = prEnd >= 0 && LIST_JOIN.test(prompt.slice(prEnd, m.index));
    if (PR_BEFORE.test(prompt.slice(0, m.index)) || listedAfterPr) {
      prEnd = m.index + m[0].length;
      continue;
    }
    prEnd = -1;
    const n = Number(m[1] ?? m[2] ?? m[3]);
    if (n > 0 && !COLOUR.test(m[0])) return n;
  }
  return null;
}

const LEADING_ISSUE = /^#(\d+)(?:\s+|$)/;

/** The issue number a workspace name starts with, or null when it starts with none. */
export const leadingIssue = (title: string): number | null => {
  const m = LEADING_ISSUE.exec(title.trim());
  return m ? Number(m[1]) : null;
};

/** `title` led by the issue number: "#123 Fix reload". */
export const withIssue = (title: string, issue: number): string => `#${issue} ${title.trim()}`.trim();

/** `title` without the issue number it starts with. */
export const withoutIssue = (title: string): string => title.trim().replace(LEADING_ISSUE, "");

/**
 * The words of a `/ws` prompt, on one line: "" for a bare `/ws`, null for
 * any other prompt.
 */
export function wsWords(prompt: string): string | null {
  const m = /^\s*\/ws(?:\s+([\s\S]*))?$/.exec(prompt);
  return m ? (m[1] ?? "").replace(/\s+/g, " ").trim() : null;
}

// Only an issue number: "#45".
const BARE_ISSUE = /^#(\d+)$/;

/** Whether renaming to `words` needs the workspace's current name: always, unless they bring their own number and more. */
export const needsCurrent = (words: string): boolean => BARE_ISSUE.test(words) || leadingIssue(words) === null;

/**
 * The name a rename to `words` (a `/ws` or a `/rename`) gives, keeping the
 * workspace's issue number: words that bring their own number win, and
 * words that are only a number put it on the current name. Null when the
 * current name is needed and not known.
 */
export function renamedTitle(words: string, current: string | null): string | null {
  const bare = BARE_ISSUE.exec(words);
  if (bare) return current === null ? null : withIssue(withoutIssue(current), Number(bare[1]));
  if (leadingIssue(words) !== null) return words;
  if (current === null) return null;
  const issue = leadingIssue(current);
  return issue === null ? words : withIssue(words, issue);
}

/** A workspace's title in `cmux --json list-workspaces` output, or null when it is not there. */
export function titleFrom(json: string, wsId: string): string | null {
  let v: unknown;
  try {
    v = JSON.parse(json);
  } catch {
    return null;
  }
  const list = field(v, "workspaces");
  if (!Array.isArray(list)) return null;
  const ws = list.find((w) => field(w, "id") === wsId || field(w, "ref") === wsId);
  const title = field(ws, "title");
  return typeof title === "string" ? title : null;
}

const fold = (s: string): string => s.trim().toLowerCase();

/** Whether a cmux group already goes by `title`, whatever its case or spacing. */
export const clashesWithGroup = (title: string, groupNames: string[]): boolean =>
  groupNames.some((g) => fold(g) === fold(title));

/**
 * The whole lines in a read of the transcript, and how many bytes they
 * take: a line still being written is left for the next read.
 */
export function wholeLines(buf: Buffer): { lines: string[]; consumed: number } {
  const end = buf.lastIndexOf(0x0a) + 1;
  return { lines: buf.subarray(0, end).toString("utf8").split("\n"), consumed: end };
}

/** Every group name in `cmux --json workspace group list` output; none when it does not parse. */
export function groupNamesFrom(json: string): string[] {
  let v: unknown;
  try {
    v = JSON.parse(json);
  } catch {
    return [];
  }
  const groups = field(v, "groups");
  if (!Array.isArray(groups)) return [];
  return groups.flatMap((g) => {
    const name = field(g, "name");
    return typeof name === "string" ? [name] : [];
  });
}

/** What the hook knows about one session in one workspace. */
export interface Stamp {
  /** Bytes of the transcript read so far, always at a line's end. */
  offset: number;
  /** The latest rename found in those bytes. */
  seen: string | null;
  /** The last rename handled: passed to cmux, or skipped for a clash. */
  handled: string | null;
  /** The session's first real prompt, once found. */
  prompt: string | null;
  /** The issue that prompt named, while it is still to go on the workspace's name. */
  issue: number | null;
}

const EMPTY: Stamp = { offset: 0, seen: null, handled: null, prompt: null, issue: null };

/** A saved stamp, or the empty one when it is missing or not the shape. */
export function parseStamp(text: string | null): Stamp {
  if (text === null) return EMPTY;
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return EMPTY;
  }
  const offset = field(v, "offset");
  const seen = field(v, "seen");
  const handled = field(v, "handled");
  const name = (x: unknown): x is string | null => x === null || typeof x === "string";
  if (typeof offset !== "number" || !Number.isInteger(offset) || offset < 0 || !name(seen) || !name(handled)) {
    return EMPTY;
  }
  const prompt = field(v, "prompt");
  // A stamp from before names were kept read past the first prompt: read
  // the transcript again from the start, keeping what was handled.
  if (!name(prompt)) return { ...EMPTY, handled };
  const issue = field(v, "issue");
  return {
    offset,
    seen,
    handled,
    prompt,
    issue: typeof issue === "number" && Number.isInteger(issue) && issue > 0 ? issue : null,
  };
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function writeStamp(path: string, stamp: Stamp): void {
  mkdirSync(STAMP_DIR, { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(stamp));
  renameSync(tmp, path);
}

// Up to `length` bytes of the file from `position`.
function readAt(fd: number, position: number, length: number): Buffer {
  const buf = Buffer.alloc(length);
  return buf.subarray(0, length ? readSync(fd, buf, 0, length, position) : 0);
}

// The stamp moved on past what was added to the transcript since, or null
// when the transcript cannot be read (a new session's is not written yet).
function scan(transcript: string, stamp: Stamp): Stamp | null {
  let fd: number;
  try {
    fd = openSync(transcript, "r");
  } catch {
    return null;
  }
  try {
    const size = fstatSync(fd).size;
    // A shorter file is a different transcript: read it from the start.
    const from = size < stamp.offset ? 0 : stamp.offset;
    const seen = size < stamp.offset ? null : stamp.seen;
    const start = Math.max(from, size - MAX_READ_BYTES);
    const { lines, consumed } = wholeLines(readAt(fd, start, size - start));
    // A read that skipped ahead begins mid-line; latestTitle skips a line it cannot parse.
    // A first prompt in what it skipped is found in a read of its head.
    const skipped =
      start > from ? firstPrompt(wholeLines(readAt(fd, from, Math.min(HEAD_BYTES, start - from))).lines) : null;
    return {
      ...stamp,
      offset: start + consumed,
      seen: latestTitle(lines) ?? seen,
      prompt: (from === 0 ? null : stamp.prompt) ?? skipped ?? firstPrompt(lines),
    };
  } finally {
    closeSync(fd);
  }
}

function readEvent(): unknown {
  try {
    return JSON.parse(readFileSync(0, "utf8"));
  } catch {
    return undefined;
  }
}

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

// Whether the state file already holds this name for the session. Read
// without the lock, so a message costs a small read, not a lock; the map
// itself is checked rather than a note in the stamp, so a name the cap
// dropped, or a reset state file, is written again.
function alreadySaved(session: string, name: SavedName): boolean {
  const text = readText(STATE_PATH);
  if (text === null) return false;
  try {
    const saved = field(field(JSON.parse(text), "names"), session);
    return field(saved, "name") === name.name && field(saved, "from") === name.from;
  } catch {
    return false;
  }
}

// Saves the session's name for the agents panel when it changed, returning
// a note for stderr when the write failed; it is tried again next run. A
// held lock throws, and is caught here so the stamp still records a rename
// already passed to cmux.
function saveName(session: string, stamp: Stamp): string | null {
  const name = sessionName(stamp.seen, stamp.prompt);
  if (!name || alreadySaved(session, name)) return null;
  let res: ReturnType<typeof writeNames>;
  try {
    res = writeNames(STATE_PATH, (names) => withName(names, session, name));
  } catch (err) {
    return `saving the name failed: ${errorText(err)}`;
  }
  if (!res.ok) return `saving the name failed: ${res.error}`;
  if (res.changed) scheduleBuild("report-rename");
  return null;
}

// A slash command as typed, "/code-review high #298": the event carries it
// raw, not tagged as the transcript has it. A path ("/Users/jon/x") is not one.
const SLASH_COMMAND = /^\s*\/[\w:-]+(?:\s|$)/;

// UserPromptSubmit runs before Claude Code writes the prompt to the
// transcript, so the first one is taken from the event itself.
export function promptFromEvent(event: unknown): string | null {
  const prompt = field(event, "prompt");
  return field(event, "hook_event_name") === "UserPromptSubmit" &&
    typeof prompt === "string" &&
    !SLASH_COMMAND.test(prompt)
    ? promptText(prompt)
    : null;
}

// Whether a name may be given: "clash" when a group already goes by it
// (the cockpit would hide the workspace), "unknown" when the group list
// cannot be read, so a clash cannot be ruled out.
function groupCheck(title: string): "ok" | "clash" | "unknown" {
  const groups = cmux(["--json", "workspace", "group", "list"]);
  if (!groups.ok) return "unknown";
  return clashesWithGroup(title, groupNamesFrom(groups.out)) ? "clash" : "ok";
}

const renameTo = (wsId: string, title: string): string | null => {
  const res = cmux(["workspace-action", "--action", "rename", "--workspace", wsId, "--title", title]);
  return res.ok ? null : `cmux rename failed: ${res.err || "cmux refused"}`;
};

// The name a rename to `words` gives, or a note saying why it cannot be
// worked out. The current name is read only when it matters.
function targetTitle(wsId: string, words: string): { title: string } | { note: string } {
  let current: string | null = null;
  if (needsCurrent(words)) {
    const now = currentTitle(wsId);
    if ("note" in now) return now;
    current = now.title;
  }
  const title = renamedTitle(words, current);
  return title === null ? { note: "the current name is not known" } : { title };
}

// Renames the workspace when the session has a new name, returning a note
// for stderr when something went wrong.
// The `/rename` keeps the workspace's issue number, as `/ws` does.
function renameWorkspace(wsId: string, stamp: Stamp): string | null {
  const seen = stamp.seen;
  if (!seen || seen === stamp.handled) return null;
  // Without the current name or the group list, try again next run.
  const target = targetTitle(wsId, seen);
  if ("note" in target) return target.note;
  const check = groupCheck(target.title);
  if (check === "unknown") return "cmux group list failed";
  if (check === "ok") {
    const note = renameTo(wsId, target.title);
    if (note) return note;
  }
  // Handled when skipped too, so a name that clashes is checked once, not every run.
  stamp.handled = seen;
  return null;
}

// The workspace's current title, or a note for stderr when cmux cannot say.
function currentTitle(wsId: string): { title: string } | { note: string } {
  const res = cmux(["--json", "list-workspaces"]);
  if (!res.ok) return { note: `cmux workspace list failed: ${res.err}` };
  const title = titleFrom(res.out, wsId);
  return title === null ? { note: "the workspace is not in cmux's list" } : { title };
}

// Puts the issue the session's first prompt named at the front of the
// workspace's name, unless it already starts with one, and clears it from
// the stamp once done. Left in the stamp when cmux could not be read or
// refused, so the next run tries again. Returns a note for stderr then.
function prefixIssue(wsId: string, stamp: Stamp): string | null {
  const issue = stamp.issue;
  if (issue === null) return null;
  const now = currentTitle(wsId);
  if ("note" in now) return now.note;
  if (leadingIssue(now.title) === null) {
    const title = withIssue(now.title, issue);
    const check = groupCheck(title);
    if (check === "unknown") return "cmux group list failed";
    const note = check === "ok" ? renameTo(wsId, title) : null;
    if (note) return note;
  }
  stamp.issue = null;
  return null;
}

// What to tell Jon after a `/ws`: the prompt is blocked either way, so the
// reason is all he sees of it.
function renameNow(wsId: string, words: string): string {
  if (!words) return "Give the workspace a name: /ws <name>, /ws #123 <name>, or /ws #123 to change only its number.";
  const target = targetTitle(wsId, words);
  if ("note" in target) return `Not renamed: ${target.note}, so its issue number could be lost. Try again.`;
  const check = groupCheck(target.title);
  if (check === "unknown")
    return "Not renamed: cmux's group list could not be read, so a clash cannot be ruled out. Try again.";
  if (check === "clash") {
    return `Not renamed: a group is already called "${target.title}", and the cockpit would hide the workspace.`;
  }
  const note = renameTo(wsId, target.title);
  return note ? `Not renamed: ${note}.` : `Workspace renamed to "${target.title}".`;
}

/** The block decision for a `/ws` prompt, as a JSON line, or null for any other event. */
function wsDecision(event: unknown, wsId: string | undefined): string | null {
  const prompt = field(event, "prompt");
  if (field(event, "hook_event_name") !== "UserPromptSubmit" || typeof prompt !== "string") return null;
  const words = wsWords(prompt);
  if (words === null) return null;
  const reason =
    wsId && ID.test(wsId) ? renameNow(wsId, words) : "Not renamed: this session is not in a cmux workspace.";
  return JSON.stringify({ decision: "block", reason });
}

// The issue to put in the workspace's name: one named by the session's
// first real prompt, when this event carries it.
function firstIssue(event: unknown, scanned: Stamp): number | null {
  if (scanned.prompt !== null || promptFromEvent(event) === null) return null;
  const prompt = field(event, "prompt");
  return typeof prompt === "string" ? issueIn(readable(prompt)) : null;
}

// Reads what the transcript added, renames the workspace and saves the
// session's name, returning the notes for stderr.
function apply(event: unknown, wsId: string | undefined): string[] {
  const session = field(event, "session_id");
  const transcript = field(event, "transcript_path");
  if (typeof session !== "string" || !ID.test(session) || typeof transcript !== "string") return [];
  if (!wsId) return [];
  if (!ID.test(wsId)) return ["skipped, the workspace id is not the expected shape"];
  const path = join(STAMP_DIR, `${session}.${wsId}.json`);
  const before = parseStamp(readText(path));
  // A new session's transcript may not be written yet: its first prompt
  // can still come from the event.
  const stamp = scan(transcript, before) ?? { ...before };
  stamp.issue ??= firstIssue(event, stamp);
  stamp.prompt ??= promptFromEvent(event);
  const notes = [renameWorkspace(wsId, stamp), prefixIssue(wsId, stamp), saveName(session, stamp)].filter(
    (n) => n !== null,
  );
  if (JSON.stringify(stamp) !== JSON.stringify(before)) writeStamp(path, stamp);
  return notes;
}

if (import.meta.main) {
  let notes: string[] = [];
  try {
    const event = readEvent();
    const wsId = process.env.CMUX_WORKSPACE_ID;
    const decision = wsDecision(event, wsId);
    // A `/ws` is not a prompt the session is named by: nothing else to do.
    if (decision) console.log(decision);
    else notes = apply(event, wsId);
  } catch (err) {
    notes = [errorText(err)];
  }
  for (const note of notes) console.error(`report-rename: ${note}`);
}
