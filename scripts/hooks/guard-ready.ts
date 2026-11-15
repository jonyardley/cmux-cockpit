// Claude Code PreToolUse hook for Bash. Before an agent's `gh pr ready` on a
// cmux-cockpit PR, it reads the PR's live description and blocks the call
// while the "Look at after reload" or "Review" section is empty or a
// placeholder, with the same rules as the PR description check. CI skips
// that check on drafts, so this is where an unfinished description is
// caught, before the PR leaves draft and the check goes red on it. PRs in
// other repos are left alone: their templates have other sections. Exit 2
// refuses the call; any other exit lets it through. A failure to read the
// description exits 2 too, since a guard that crashes must not fail open.
// guard-ready.sh runs first, so only a command that mentions it starts node.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { bodyMessage, fetchBody } from "../pr-body.ts";
import { checkoutRoot } from "./checkout.ts";
import { field, ghPr, SEGMENTS } from "./gh-command.ts";

const PR_READY = ghPr("ready");
const REPO_FLAGS = new Set(["-R", "--repo"]);
// A redirection or background marker ends gh's own arguments.
const SHELL_OP = /^(?:\d*[<>]|&)/;
const THIS_REPO = /(?:^|\/)cmux-cockpit$/i;
const THIS_REPO_PR = /\/cmux-cockpit\/pull\/\d+/i;

/** A `gh pr ready` the command runs: which PR, in which repo, and where. */
export interface ReadyCall {
  pr: string | null;
  repo: string | null;
  cwd: string | undefined;
}

// Separators inside quotes become spaces, so a quoted body that mentions
// `; gh pr ready` is not read as a command of its own. The quotes go too.
function unquote(command: string): string {
  return command.replace(/"[^"]*"|'[^']*'/g, (q) => q.slice(1, -1).replace(/[;&|\n]/g, " "));
}

// The repo a `-R`, `--repo` or `--repo=` names among `words`, if any.
function repoFlag(words: string[]): string | null {
  for (const [i, w] of words.entries()) {
    if (w.startsWith("--repo=")) return w.slice("--repo=".length);
    if (REPO_FLAGS.has(w)) return words[i + 1] ?? null;
  }
  return null;
}

// Reads one `gh pr ready` segment. `--undo` goes back to draft, so it is
// never blocked: that returns null. The PR is the first argument after
// `ready` that is neither a flag nor a flag's value.
function readSegment(segment: string, cwd: string | undefined): ReadyCall | null {
  const words = segment.trim().split(/\s+/);
  const at = words.indexOf("ready");
  const opEnd = words.findIndex((w, i) => i > at && SHELL_OP.test(w));
  const own = opEnd === -1 ? words.slice(at + 1) : words.slice(at + 1, opEnd);
  if (own.includes("--undo")) return null;
  const pr = own.find((w, i) => !w.startsWith("-") && !REPO_FLAGS.has(own[i - 1] ?? "")) ?? null;
  const env = words.find((w) => w.startsWith("GH_REPO="))?.slice("GH_REPO=".length) ?? null;
  const repo = repoFlag(own) ?? repoFlag(words.slice(0, at)) ?? env;
  return { pr, repo, cwd };
}

// Where a `cd` lands from `cwd`, or undefined when that cannot be known.
function cdTo(dir: string, cwd: string | undefined): string | undefined {
  if (dir === "~" || dir.startsWith("~/")) return join(homedir(), dir.slice(1));
  if (isAbsolute(dir)) return dir;
  return cwd === undefined ? undefined : resolve(cwd, dir);
}

// The `gh pr ready` a Bash event would run, or null when it runs none. The
// directory is the event's cwd, moved by any `cd` earlier in the command.
export function readyCall(event: unknown): ReadyCall | null {
  if (field(event, "tool_name") !== "Bash") return null;
  const command = field(field(event, "tool_input"), "command");
  if (typeof command !== "string") return null;
  const eventCwd = field(event, "cwd");
  let cwd = typeof eventCwd === "string" ? eventCwd : undefined;
  for (const segment of unquote(command).split(SEGMENTS)) {
    const cd = /^\s*cd\s+(\S+)\s*$/.exec(segment)?.[1];
    if (cd !== undefined) cwd = cdTo(cd, cwd);
    if (PR_READY.test(segment)) return readSegment(segment, cwd);
  }
  return null;
}

// True when the call readies a cmux-cockpit PR, judged by its URL, its repo
// flag, or failing both the checkout it runs in.
export function isOurs(call: ReadyCall): boolean {
  if (call.pr !== null && /^https?:\/\//.test(call.pr)) return THIS_REPO_PR.test(call.pr);
  if (call.repo !== null) return THIS_REPO.test(call.repo);
  return call.cwd !== undefined && checkoutRoot(join(call.cwd, "package.json")) !== null;
}

function main(): number {
  try {
    const call = readyCall(JSON.parse(readFileSync(0, "utf8")));
    if (!call || !isOurs(call)) return 0;
    const body = fetchBody(call.pr, call.cwd, call.repo);
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
