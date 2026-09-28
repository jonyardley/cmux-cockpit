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
//
// A create is also recorded in config/state.json's `prOrigins` map, with
// the session, workspace and terminal that ran it, so the agents panel can
// say which chat opened each PR and switch back to it.

import { spawn, spawnSync } from "node:child_process";
import { closeSync, openSync, readFileSync } from "node:fs";
import { createConnection } from "node:net";
import { join } from "node:path";
import { scheduleBuild } from "../hook-build.ts";
import { isId, type SavedPrOrigin, type State } from "../state-config.ts";
import { LOG_PATH } from "../state-log.ts";
import { writePrOrigins } from "../state-url.ts";
import { field, ghPr, SEGMENTS } from "./gh-command.ts";

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

const PR_CREATE = ghPr("create|new");
// The commands that change a PR's draft, merged or closed state on GitHub.
const PR_SETTLE = ghPr("ready|merge|close|reopen");
const PR_URL = /https:\/\/\S+\/pull\/\d+/g;

// The URL `gh pr create` printed, or null when the event is not a Bash call
// that ran it, or it failed and printed none. The URL pins the exact PR, so
// the lookup does not depend on which directory the command ran in.
// True when the event is a Bash call that ran a command `re` matches at the
// start of one of its shell segments.
function ranGhPr(event: unknown, re: RegExp): boolean {
  if (field(event, "tool_name") !== "Bash") return false;
  const command = field(field(event, "tool_input"), "command");
  return typeof command === "string" && command.split(SEGMENTS).some((c) => re.test(c));
}

export function createdPrUrl(event: unknown): string | null {
  if (!ranGhPr(event, PR_CREATE)) return null;
  const stdout = field(field(event, "tool_response"), "stdout");
  if (typeof stdout !== "string") return null;
  // gh prints the new PR's URL last, after anything earlier commands printed.
  return stdout.match(PR_URL)?.at(-1) ?? null;
}

// True when the event is a Bash call that ran `gh pr ready`, `merge`,
// `close` or `reopen` in the foreground. A backgrounded call fires this hook
// as soon as it starts, before gh has changed anything, so it is left to the
// turn-end poll. A failed one still counts: its poll finds nothing changed.
export function settledPr(event: unknown): boolean {
  if (field(field(event, "tool_input"), "run_in_background") === true) return false;
  return ranGhPr(event, PR_SETTLE);
}

/** What the hook does for an event: report a new PR, poll after a settle, or nothing. */
export type Step = { kind: "report"; url: string } | { kind: "poll" } | null;

export function stepFor(event: unknown): Step {
  const url = createdPrUrl(event);
  if (url !== null) return { kind: "report", url };
  return settledPr(event) ? { kind: "poll" } : null;
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

// The cmux ids the hook inherits, for saying where a PR was opened.
interface OriginEnv {
  CMUX_WORKSPACE_ID?: string | undefined;
  CMUX_SURFACE_ID?: string | undefined;
}

/** Origins older than this are dropped on every write: 30 days. */
export const ORIGIN_MAX_AGE_S = 30 * 24 * 60 * 60;

/**
 * Where a PR the agent just created came from, or null without a session
 * or workspace to name. The number comes from the URL, so this needs no gh.
 */
export function originFrom(url: string, event: unknown, env: OriginEnv, now: number): SavedPrOrigin | null {
  const number = Number(/\/pull\/(\d+)$/.exec(url)?.[1]);
  const session = field(event, "session_id");
  const { CMUX_WORKSPACE_ID: workspace, CMUX_SURFACE_ID: surface } = env;
  if (!Number.isSafeInteger(number) || number < 1) return null;
  if (typeof session !== "string" || !isId(session) || !workspace || !isId(workspace)) return null;
  const origin: SavedPrOrigin = { url, number, workspace, session, epoch: now };
  if (surface && isId(surface)) origin.surface = surface;
  return origin;
}

/**
 * Adds one origin, moved last as the newest, and drops every origin older
 * than ORIGIN_MAX_AGE_S. The input is not changed.
 */
export function addOrigin(map: State["prOrigins"], origin: SavedPrOrigin, now: number): State["prOrigins"] {
  const kept = Object.entries(map).filter(([url, o]) => url !== origin.url && now - o.epoch <= ORIGIN_MAX_AGE_S);
  return Object.fromEntries([...kept, [origin.url, origin]]);
}

const STATE_PATH = join(import.meta.dirname, "..", "..", "config", "state.json");

// Saves where the PR came from; a failure is a note, never a failed hook.
function recordOrigin(url: string, event: unknown): void {
  const now = Math.floor(Date.now() / 1000);
  const origin = originFrom(url, event, process.env, now);
  if (!origin) {
    console.error("report-pr: origin skipped, no session or cmux workspace");
    return;
  }
  try {
    const result = writePrOrigins(STATE_PATH, (map) => addOrigin(map, origin, now));
    if (!result.ok) console.error(`report-pr: origin: ${result.error}`);
    else if (result.changed) scheduleBuild("report-pr");
  } catch (err) {
    console.error(`report-pr: origin: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// Long enough for gh to list a PR it has just created: a poll a second after
// the create found none (docs/state-loop.md).
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
  const step = stepFor(event);
  if (!step) return;
  const socket = process.env.CMUX_SOCKET_PATH;
  if (!socket) return console.error("report-pr: skipped, not in a cmux terminal");
  if (step.kind === "poll") return startPoll(SETTLE_DELAY_SECONDS);
  const { url } = step;
  recordOrigin(url, event);
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
