// Tells cmux about a PR an agent just opened (#7).
//
// cmux learns about PRs from its shell integration, which sends `report_pr`
// down the app socket when a PR command is typed in the terminal. A PR an
// agent opens from its own subprocess never sends that, so cmux shows no PR.
// Run as a Claude Code PostToolUse hook on Bash: it reads the hook event on
// stdin, and after a `gh pr create` it asks gh for the PR and sends the same
// line the shell integration would. It never fails the hook: every problem
// is a note on stderr and exit 0.

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
  CMUX_SOCKET_PATH?: string | undefined;
  CMUX_TAB_ID?: string | undefined;
  CMUX_PANEL_ID?: string | undefined;
  CMUX_SOCKET_CAPABILITY?: string | undefined;
}

function record(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : null;
}

// The directory to look the PR up in, or null when the event is not a Bash
// call that ran `gh pr create`.
export function prCreateCwd(event: unknown): string | null {
  const e = record(event);
  if (e?.tool_name !== "Bash" || typeof e.cwd !== "string") return null;
  const command = record(e.tool_input)?.command;
  if (typeof command !== "string" || !/\bgh\s+pr\s+create\b/.test(command)) return null;
  return e.cwd;
}

export function parsePr(json: string): Pr | null {
  let v: unknown;
  try {
    v = JSON.parse(json);
  } catch {
    return null;
  }
  const p = record(v);
  if (!p) return null;
  const { number, url, state, headRefName } = p;
  if (typeof number !== "number" || typeof url !== "string" || typeof state !== "string") return null;
  if (typeof headRefName !== "string") return null;
  return { number, url, state, headRefName };
}

const TOKEN = /^\S+$/;

// The socket line, as the shell integration writes it, or null when cmux's
// env is missing or a field would break the space-separated line.
export function payload(pr: Pr, env: CmuxEnv): string | null {
  const { CMUX_TAB_ID: tab, CMUX_PANEL_ID: panel, CMUX_SOCKET_CAPABILITY: cap } = env;
  if (!tab || !panel) return null;
  const fields = [pr.url, pr.headRefName, tab, panel];
  if (!fields.every((f) => TOKEN.test(f))) return null;
  const state = pr.state.toLowerCase();
  const line = `report_pr ${pr.number} ${pr.url} --state=${state} --branch=${pr.headRefName} --tab=${tab} --panel=${panel}`;
  return cap ? `_cmux_capability_v1 ${cap} ${line}` : line;
}

function send(socket: string, line: string): Promise<void> {
  return new Promise((resolve) => {
    const conn = createConnection(socket, () => conn.end(`${line}\n`));
    conn.setTimeout(1000, () => conn.destroy());
    conn.on("error", (err) => {
      console.error(`report-pr: socket: ${err.message}`);
      resolve();
    });
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
  const cwd = prCreateCwd(event);
  if (!cwd) return;
  const socket = process.env.CMUX_SOCKET_PATH;
  if (!socket) return console.error("report-pr: skipped, not in a cmux terminal");
  const gh = spawnSync("gh", ["pr", "view", "--json", "number,url,state,headRefName"], { cwd, encoding: "utf8" });
  const pr = gh.status === 0 ? parsePr(gh.stdout) : null;
  if (!pr) return console.error("report-pr: skipped, gh found no PR for this branch");
  const line = payload(pr, process.env);
  if (!line) return console.error("report-pr: skipped, cmux tab or panel id missing");
  await send(socket, line);
}

if (import.meta.main) await main();
