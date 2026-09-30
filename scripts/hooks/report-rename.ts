// Carries a Claude Code `/rename` over to the cmux workspace, so the
// sidebar row shows the name Jon gave the session. `/rename` only writes a
// custom-title line into the transcript and fires no hook, and cmux never
// reads it, so without this the row keeps its old name.
//
// Run by scripts/hooks/dispatch.ts on UserPromptSubmit and SessionStart:
// the name moves on the next message after a rename, or when a renamed
// session is resumed. A small file per session and workspace under config/renames/
// holds how far into the transcript the hook has read, the latest rename
// seen there and the last one it handled, so each message reads only what
// was added since, and a name Jon later gives the workspace in cmux by hand
// is not put back on every message. A name that matches a cmux group's name
// is skipped: the cockpit takes a workspace titled after its group for the
// group's generated placeholder (isGeneratedAnchor in src/cockpit/model.ts)
// and would hide it. It never fails the hook: every problem is a note on
// stderr and exit 0.

import { spawnSync } from "node:child_process";
import { closeSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { field } from "./gh-command.ts";

// A new stretch of transcript is normally a few kilobytes; this bounds the
// first read of a long one, whose rename can sit anywhere in it.
const MAX_READ_BYTES = 64 * 1024 * 1024;
const STAMP_DIR = join(import.meta.dirname, "..", "..", "config", "renames");
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

function cmux(args: string[]): { ok: boolean; out: string; err: string } {
  const bin = process.env.CMUX_CLAUDE_HOOK_CMUX_BIN || "cmux";
  const res = spawnSync(bin, args, { encoding: "utf8", timeout: 5000, env: { ...process.env, CMUX_QUIET: "1" } });
  return { ok: res.status === 0, out: res.stdout ?? "", err: (res.stderr || res.error?.message || "").trim() };
}

/** What the hook knows about one session in one workspace. */
export interface Stamp {
  /** Bytes of the transcript read so far, always at a line's end. */
  offset: number;
  /** The latest rename found in those bytes. */
  seen: string | null;
  /** The last rename handled: passed to cmux, or skipped for a clash. */
  handled: string | null;
}

const EMPTY: Stamp = { offset: 0, seen: null, handled: null };

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
  return { offset, seen, handled };
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
    const buf = Buffer.alloc(size - start);
    const got = buf.length ? readSync(fd, buf, 0, buf.length, start) : 0;
    const { lines, consumed } = wholeLines(buf.subarray(0, got));
    // A read that skipped ahead begins mid-line; latestTitle skips a line it cannot parse.
    return { offset: start + consumed, seen: latestTitle(lines) ?? seen, handled: stamp.handled };
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

// Renames the workspace when the session has a new name, returning a note
// for stderr when something went wrong.
function apply(event: unknown, wsId: string | undefined): string | null {
  const session = field(event, "session_id");
  const transcript = field(event, "transcript_path");
  if (typeof session !== "string" || !ID.test(session) || typeof transcript !== "string") return null;
  if (!wsId) return null;
  if (!ID.test(wsId)) return "skipped, the workspace id is not the expected shape";
  const path = join(STAMP_DIR, `${session}.${wsId}.json`);
  const before = parseStamp(readText(path));
  const stamp = scan(transcript, before);
  if (!stamp) return null;
  const title = stamp.seen;
  if (title && title !== stamp.handled) {
    const groups = cmux(["--json", "workspace", "group", "list"]);
    // Without the group list a clash cannot be ruled out, so try again next message.
    if (!groups.ok) return `cmux group list failed: ${groups.err}`;
    if (!clashesWithGroup(title, groupNamesFrom(groups.out))) {
      const res = cmux(["workspace-action", "--action", "rename", "--workspace", wsId, "--title", title]);
      if (!res.ok) return `cmux rename failed: ${res.err}`;
    }
    // Handled when skipped too, so a name that clashes is checked once, not every message.
    stamp.handled = title;
  }
  if (JSON.stringify(stamp) !== JSON.stringify(before)) writeStamp(path, stamp);
  return null;
}

if (import.meta.main) {
  let note: string | null;
  try {
    note = apply(readEvent(), process.env.CMUX_WORKSPACE_ID);
  } catch (err) {
    note = errorText(err);
  }
  if (note) console.error(`report-rename: ${note}`);
}
