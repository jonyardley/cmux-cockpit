// Tells cmux about a PR an agent just opened (#7).
//
// cmux learns about PRs from its shell integration, which sends `report_pr`
// down the app socket for PR commands typed in the terminal. A PR an agent
// opens from its own subprocess never sends that, so cmux shows no PR.
// Run as a Claude Code PostToolUse hook on Bash: after a `gh pr create` that
// printed a PR URL, it asks gh for that PR and sends the line the shell
// integration would (Resources/shell-integration/cmux-zsh-integration.zsh,
// `report_pr` and `_cmux_write_socket_payload`, cmux 0.64). It also starts
// a PR poll a few seconds later, since the poll the agent's turn end fires
// straight after a create can run before gh lists the new PR. After a
// `gh pr ready` or `gh pr merge` it starts a poll too, so the chip catches
// up without waiting for the next turn end or workspace switch. It never
// fails the hook: every problem is a note on stderr and exit 0.

import { spawn, spawnSync } from "node:child_process";
import { closeSync, openSync, readFileSync } from "node:fs";
import { createConnection } from "node:net";
import { join } from "node:path";
import { LOG_PATH } from "../state-log.ts";

export interface Pr {
  number: number;
  url: string;
  state: string;
  headRefName: string;
}

// The workspace-level env cmux sets in its terminals, which hooks inherit.
interface CmuxEnv {
  CMUX_TAB_ID?: string | undefined;
  CMUX_PANEL_ID?: string | undefined;
  CMUX_SOCKET_CAPABILITY?: string | undefined;
}

// `gh [global flags] pr create|new` at the start of a shell segment, so a
// command that only mentions it (grep, a quoted body) does not count.
// Leading env assignments (`GH_REPO=o/r gh ...`) count too, and so does an
// `rtk` prefix: the RTK PreToolUse hook rewrites most creates to `rtk gh`,
// this hook sees the rewritten command, and RTK leaves some forms (a heredoc
// body, `gh -R`) as plain `gh`, so both must match.
const ghPr = (verbs: string) =>
  new RegExp(String.raw`^\s*(?:\w+=\S*\s+)*(?:rtk\s+)?gh\s+(?:-\S+\s+(?:[^-\s]\S*\s+)?)*pr\s+(?:${verbs})(?![\w-])`);
const PR_CREATE = ghPr("create|new");
// The commands that change a PR's draft or merged state on GitHub.
const PR_SETTLE = ghPr("ready|merge");
const SEGMENTS = /&&|\|\||[;|\n]/;
const PR_URL = /https:\/\/\S+\/pull\/\d+/g;

function field(obj: unknown, key: string): unknown {
  return typeof obj === "object" && obj !== null && key in obj ? Reflect.get(obj, key) : undefined;
}

// The URL `gh pr create` printed, or null when the event is not a Bash call
// that ran it, or it failed and printed none. The URL pins the exact PR, so
// the lookup does not depend on which directory the command ran in.
export function createdPrUrl(event: unknown): string | null {
  if (field(event, "tool_name") !== "Bash") return null;
  const command = field(field(event, "tool_input"), "command");
  if (typeof command !== "string" || !command.split(SEGMENTS).some((c) => PR_CREATE.test(c))) return null;
  const stdout = field(field(event, "tool_response"), "stdout");
  if (typeof stdout !== "string") return null;
  // gh prints the new PR's URL last, after anything earlier commands printed.
  return stdout.match(PR_URL)?.at(-1) ?? null;
}

// True when the event is a Bash call that ran `gh pr ready` or `gh pr merge`.
// A failed one still counts: the poll it starts finds nothing changed.
export function settledPr(event: unknown): boolean {
  if (field(event, "tool_name") !== "Bash") return false;
  const command = field(field(event, "tool_input"), "command");
  return typeof command === "string" && command.split(SEGMENTS).some((c) => PR_SETTLE.test(c));
}

export function parsePr(json: string): Pr | null {
  let v: unknown;
  try {
    v = JSON.parse(json);
  } catch {
    return null;
  }
  const [number, url, state, headRefName] = ["number", "url", "state", "headRefName"].map((k) => field(v, k));
  if (typeof number !== "number" || typeof url !== "string" || typeof state !== "string") return null;
  if (typeof headRefName !== "string") return null;
  return { number, url, state, headRefName };
}

const STATES = new Map([
  ["OPEN", "open"],
  ["MERGED", "merged"],
  ["CLOSED", "closed"],
]);
const TOKEN = /^\S+$/;

// The socket line, as the shell integration writes it, or null when cmux's
// env is missing or a field would break the space-separated line. The
// branch is the PR's head ref: the shell integration sends the local
// branch, which is the same name unless it was pushed under another.
export function payload(pr: Pr, env: CmuxEnv): string | null {
  const { CMUX_TAB_ID: tab, CMUX_PANEL_ID: panel, CMUX_SOCKET_CAPABILITY: cap } = env;
  const state = STATES.get(pr.state);
  if (!tab || !panel || !state) return null;
  if (![pr.url, tab, panel].every((f) => TOKEN.test(f))) return null;
  const branch = pr.headRefName.replaceAll('"', '\\"');
  const line = `report_pr ${pr.number} ${pr.url} --state=${state} --branch="${branch}" --tab=${tab} --panel=${panel}`;
  return cap && TOKEN.test(cap) ? `_cmux_capability_v1 ${cap} ${line}` : line;
}

// Long enough for gh to list a PR it has just created: the turn-end poll a
// second after the create found none (docs/state-loop.md).
const POLL_DELAY_SECONDS = 10;
// After a ready or merge GitHub already has the new state, so a second is
// enough. Any delay at all makes the poll wait for a run holding the lock
// rather than skip, and that run may have read GitHub before the change.
export const SETTLE_DELAY_SECONDS = 1;

export interface Spawn {
  command: string;
  args: string[];
  cwd: string;
}

// The delayed poll to start after a create: pr-poll.ts in this checkout,
// run by the node running this hook, so no PATH lookup or shell is needed.
export function delayedPoll(hookDir: string, node: string, seconds = POLL_DELAY_SECONDS): Spawn {
  const root = join(hookDir, "..", "..");
  return {
    command: node,
    args: [join(root, "scripts", "pr-poll.ts"), "--delay", String(seconds)],
    cwd: root,
  };
}

// Detached and unreferenced, so the hook returns at once and the poll
// outlives it; its lockfile keeps it from overlapping an automation's run.
// Its stderr goes to the state log, so a poll that crashes before it can log
// still leaves a trace; if the log cannot be opened the poll runs without.
function logFd(): number | "ignore" {
  try {
    return openSync(LOG_PATH, "a");
  } catch {
    return "ignore";
  }
}

function startPoll(seconds?: number): void {
  const { command, args, cwd } = delayedPoll(import.meta.dirname, process.execPath, seconds);
  const log = logFd();
  try {
    const child = spawn(command, args, { cwd, detached: true, stdio: ["ignore", "ignore", log] });
    child.on("error", (err) => console.error(`report-pr: poll: ${err.message}`));
    child.unref();
  } catch (err) {
    console.error(`report-pr: poll: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    if (log !== "ignore") closeSync(log);
  }
}

function send(socket: string, line: string): Promise<void> {
  return new Promise((resolve) => {
    const conn = createConnection(socket, () => conn.end(`${line}\n`));
    // Drain any reply so the socket closes when cmux does, not on the timeout.
    conn.resume();
    conn.setTimeout(1000, () => conn.destroy());
    conn.on("error", (err) => console.error(`report-pr: socket: ${err.message}`));
    conn.on("close", () => resolve());
  });
}

async function main(): Promise<void> {
  let event: unknown;
  try {
    event = JSON.parse(readFileSync(0, "utf8"));
  } catch {
    return;
  }
  const url = createdPrUrl(event);
  if (url === null && !settledPr(event)) return;
  const socket = process.env.CMUX_SOCKET_PATH;
  if (!socket) return console.error("report-pr: skipped, not in a cmux terminal");
  if (url === null) return startPoll(SETTLE_DELAY_SECONDS);
  startPoll();
  const gh = spawnSync("gh", ["pr", "view", url, "--json", "number,url,state,headRefName"], {
    encoding: "utf8",
    timeout: 5000,
  });
  const pr = gh.status === 0 ? parsePr(gh.stdout) : null;
  if (!pr) return console.error(`report-pr: skipped, gh could not read ${url}`);
  const line = payload(pr, process.env);
  if (!line)
    return console.error("report-pr: skipped, cmux tab or panel id missing, or an unexpected PR state or field");
  await send(socket, line);
}

if (import.meta.main) await main();
