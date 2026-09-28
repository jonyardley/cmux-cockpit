// Claude Code PreToolUse hook for Bash. Before an agent's `gh pr ready`, it
// reads the PR's live description and blocks the call while the "Look at
// after reload" or "Review" section is empty or a placeholder, with the same
// rules as the PR description check. CI skips that check on drafts, so this
// is where an unfinished description is caught, before the PR leaves draft
// and the check goes red on it. Exit 2 refuses the call; any other exit lets
// it through. A failure to read the description exits 2 too, since a guard
// that crashes must not fail open.

import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { bodyMessage, fetchBody } from "../pr-body.ts";

// `gh [global flags] pr ready` at the start of a shell segment, with an
// optional `rtk` prefix and env assignments, as in report-pr.ts.
const PR_READY = /^\s*(?:\w+=\S*\s+)*(?:rtk\s+)?gh\s+(?:-\S+\s+(?:[^-\s]\S*\s+)?)*pr\s+ready(?![\w-])(.*)$/;
const CD = /^\s*cd\s+(\S+)\s*$/;
const SEGMENTS = /&&|\|\||[;|\n]/;

/** A `gh pr ready` the command runs: which PR, and where it runs. */
export interface ReadyCall {
  pr: string | null;
  cwd: string | undefined;
}

function field(obj: unknown, key: string): unknown {
  return typeof obj === "object" && obj !== null && key in obj ? Reflect.get(obj, key) : undefined;
}

// The PR a `gh pr ready` names: its first argument that is not a flag, or
// null for the current branch. `--undo` goes back to draft, so it is never
// blocked; it returns undefined.
function readyTarget(rest: string): string | null | undefined {
  const words = rest
    .trim()
    .split(/\s+/)
    .filter((w) => w !== "");
  if (words.includes("--undo")) return undefined;
  return words.find((w) => !w.startsWith("-")) ?? null;
}

// The `gh pr ready` a Bash event would run, or null when it runs none. The
// directory is the event's cwd, or an absolute `cd` earlier in the command.
export function readyCall(event: unknown): ReadyCall | null {
  if (field(event, "tool_name") !== "Bash") return null;
  const command = field(field(event, "tool_input"), "command");
  if (typeof command !== "string") return null;
  const eventCwd = field(event, "cwd");
  let cwd = typeof eventCwd === "string" ? eventCwd : undefined;
  for (const segment of command.split(SEGMENTS)) {
    const dir = CD.exec(segment)?.[1];
    if (dir !== undefined && isAbsolute(dir)) cwd = dir;
    const rest = PR_READY.exec(segment)?.[1];
    if (rest === undefined) continue;
    const pr = readyTarget(rest);
    if (pr !== undefined) return { pr, cwd };
  }
  return null;
}

function main(): number {
  try {
    const call = readyCall(JSON.parse(readFileSync(0, "utf8")));
    if (!call) return 0;
    const body = fetchBody(call.pr, call.cwd);
    if (body instanceof Error) {
      console.error(`Blocked by scripts/hooks/guard-ready.ts: could not read the PR description. ${body.message}`);
      return 2;
    }
    const message = bodyMessage(body);
    if (!message) return 0;
    console.error(`Blocked by scripts/hooks/guard-ready.ts: ${message} Then run \`gh pr ready\` again.`);
  } catch (err) {
    console.error(`Blocked: scripts/hooks/guard-ready.ts failed, so \`gh pr ready\` is refused. ${String(err)}`);
  }
  return 2;
}

if (import.meta.main) process.exit(main());
