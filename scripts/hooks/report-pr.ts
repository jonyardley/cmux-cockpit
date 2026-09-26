// Tells cmux about a PR an agent just opened (#7).
//
// cmux learns about PRs from its shell integration, which sends `report_pr`
// down the app socket for PR commands typed in the terminal. A PR an agent
// opens from its own subprocess never sends that, so cmux shows no PR.
// Run as a Claude Code PostToolUse hook on Bash: after a `gh pr create` that
// printed a PR URL, it asks gh for that PR and sends the line the shell
// integration would (Resources/shell-integration/cmux-zsh-integration.zsh,
// `report_pr` and `_cmux_write_socket_payload`, cmux 0.64). It never fails
// the hook: every problem is a note on stderr and exit 0.

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createConnection } from "node:net";

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
const PR_CREATE = /^\s*gh\s+(?:-\S+\s+(?:[^-\s]\S*\s+)?)*pr\s+(?:create|new)(?![\w-])/;
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
  if (!url) return;
  const socket = process.env.CMUX_SOCKET_PATH;
  if (!socket) return console.error("report-pr: skipped, not in a cmux terminal");
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
