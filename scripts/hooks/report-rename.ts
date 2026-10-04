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
}

const EMPTY: Stamp = { offset: 0, seen: null, handled: null, prompt: null };

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
  return { offset, seen, handled, prompt };
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

// UserPromptSubmit runs before Claude Code writes the prompt to the
// transcript, so the first one is taken from the event itself.
export function promptFromEvent(event: unknown): string | null {
  const prompt = field(event, "prompt");
  return field(event, "hook_event_name") === "UserPromptSubmit" && typeof prompt === "string"
    ? promptText(prompt)
    : null;
}

// Renames the workspace when the session has a new name, returning a note
// for stderr when something went wrong.
function renameWorkspace(wsId: string, stamp: Stamp): string | null {
  const title = stamp.seen;
  if (!title || title === stamp.handled) return null;
  const groups = cmux(["--json", "workspace", "group", "list"]);
  // Without the group list a clash cannot be ruled out, so try again next run.
  if (!groups.ok) return `cmux group list failed: ${groups.err}`;
  if (!clashesWithGroup(title, groupNamesFrom(groups.out))) {
    const res = cmux(["workspace-action", "--action", "rename", "--workspace", wsId, "--title", title]);
    if (!res.ok) return `cmux rename failed: ${res.err}`;
  }
  // Handled when skipped too, so a name that clashes is checked once, not every run.
  stamp.handled = title;
  return null;
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
  stamp.prompt ??= promptFromEvent(event);
  const notes = [renameWorkspace(wsId, stamp), saveName(session, stamp)].filter((n) => n !== null);
  if (JSON.stringify(stamp) !== JSON.stringify(before)) writeStamp(path, stamp);
  return notes;
}

if (import.meta.main) {
  let notes: string[];
  try {
    notes = apply(readEvent(), process.env.CMUX_WORKSPACE_ID);
  } catch (err) {
    notes = [errorText(err)];
  }
  for (const note of notes) console.error(`report-rename: ${note}`);
}
