// Carries a Claude Code `/rename` over to the cmux workspace, so the
// sidebar row shows the name Jon gave the session. `/rename` only writes a
// custom-title line into the transcript and fires no hook, and cmux never
// reads it, so without this the row keeps its old name.
//
// Run as a Claude Code UserPromptSubmit and SessionStart hook: the name
// moves on the next message after a rename, or when a renamed session is
// resumed. It passes a name to cmux only when it differs from the last one
// this hook passed for the session (kept in a small file per session under
// the temp folder), so a name Jon later gives the workspace in cmux by hand
// is not put back on every message. A name that matches a cmux group's name
// is skipped: the cockpit takes a workspace titled after its group for the
// group's generated placeholder (isGeneratedAnchor in src/cockpit/model.ts)
// and would hide it. It never fails the hook: every problem is a note on
// stderr and exit 0.

import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { field } from "./gh-command.ts";
import { readTail } from "./transcript.ts";

// A long session's transcript runs to megabytes, and the rename can sit
// anywhere in it; this bounds a pathological one.
const MAX_TRANSCRIPT_BYTES = 64 * 1024 * 1024;
const STAMP_DIR = join(tmpdir(), "cmux-cockpit-renames");
const SESSION_ID = /^[\w-]{1,128}$/;

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

/**
 * The name to pass to cmux, or null for none: no rename, the same name as
 * last time, or a name a cmux group already goes by.
 */
export function renameFor(title: string | null, lastApplied: string | null, groupNames: string[]): string | null {
  if (!title || title === lastApplied) return null;
  return groupNames.some((g) => fold(g) === fold(title)) ? null : title;
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

function readStamp(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
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
  if (typeof session !== "string" || !SESSION_ID.test(session) || typeof transcript !== "string") return null;
  const stamp = join(STAMP_DIR, session);
  const title = latestTitle(readTail(transcript, MAX_TRANSCRIPT_BYTES));
  const last = readStamp(stamp);
  if (!title || title === last) return null;
  if (!wsId) return "skipped, not in a cmux workspace";
  const groups = cmux(["--json", "workspace", "group", "list"]);
  // Without the group list a clash cannot be ruled out, so try again next message.
  if (!groups.ok) return `cmux group list failed: ${groups.err}`;
  const name = renameFor(title, last, groupNamesFrom(groups.out));
  if (name) {
    const res = cmux(["workspace-action", "--action", "rename", "--workspace", wsId, "--title", name]);
    if (!res.ok) return `cmux rename failed: ${res.err}`;
  }
  // Stamped when skipped too, so a name that clashes is checked once, not every message.
  mkdirSync(STAMP_DIR, { recursive: true });
  writeFileSync(stamp, title);
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
