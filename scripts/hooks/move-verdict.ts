// A small model's verdict on a turn's final reply: does it wait on Jon?
// The move hook (report-move.ts) saves the move from the reply's wording at
// once, then starts this file detached with the reply, so the Stop hook
// never waits on a model. Here `claude -p` with Haiku reads the reply, and
// when it answers inside VERDICT_TIMEOUT_MS the verdict is written onto the
// same saved move, in the cmux description or in config/state.json's
// `moves`, whichever holds it, but only while that move is still the one
// this run was started for. Any failure writes nothing, so the wording
// flags stand. The core and the agents panel let a verdict override them
// (asks_nothing in native/core/src/moves.rs, asksNothing in
// src/shared/move.ts).
//
// `node scripts/hooks/move-verdict.ts --replay <file>` reads JSON lines of
// replies (a string, or an object with `text`) and prints each verdict, to
// set the model against the wording rules on past replies.

import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scheduleBuild } from "../hook-build.ts";
import {
  isId,
  type MoveVerdict,
  moveDescription,
  moveOfDescription,
  type SavedMove,
  splitContext,
  validateState,
  withContext,
} from "../state-config.ts";
import { logLine } from "../state-log.ts";
import { readApplyWrite } from "../state-url.ts";
import { type DescriptionRead, readDescription, withDescriptionLock, writeDescription } from "./description.ts";
import { field } from "./gh-command.ts";

/** Set on the model's own process, so its hooks, if any load, save no move of their own. */
export const CHILD_ENV = "COCKPIT_VERDICT_CHILD";
/** How long the model gets before the run gives up and writes nothing. */
export const VERDICT_TIMEOUT_MS = 20_000;
/** The most of a reply the model reads; the end is kept, where the ask sits. */
export const REPLY_CAP = 6000;

/** The move a run was started for: a verdict lands only on this move. */
export interface VerdictTarget {
  wsId: string;
  epoch: number;
  session?: string;
  text: string;
}

/** The target for a move just saved in workspace `wsId`. */
export const verdictTarget = (wsId: string, m: SavedMove): VerdictTarget => ({
  wsId,
  epoch: m.epoch,
  text: m.text,
  ...(m.session !== undefined ? { session: m.session } : {}),
});

const SCHEMA = '{"type":"object","properties":{"waiting":{"type":"boolean"}},"required":["waiting"]}';

/** What the model is asked, the reply cut to its last REPLY_CAP characters. */
export function verdictPrompt(reply: string): string {
  const cut = reply.length > REPLY_CAP ? reply.slice(-REPLY_CAP) : reply;
  return [
    "The text between the markers is a coding agent's reply to its human, at the end of the agent's turn.",
    'Answer "waiting": true when the reply waits on the human now: it asks a question, offers options or a decision,',
    "asks for approval, a go, a review or a paste, or tells the human to do something now.",
    'Answer "waiting": false when it reports progress or says nothing is needed, even when it describes the',
    'agent\'s own next steps ("After it I push, open a draft PR, and ask for your word") or an ask that comes later.',
    "",
    "<<<REPLY",
    cut,
    "REPLY>>>",
  ].join("\n");
}

/** The `claude` arguments for one verdict. */
export const claudeArgs = (prompt: string): string[] => [
  "-p",
  "--model",
  "haiku",
  "--setting-sources",
  "",
  "--no-session-persistence",
  "--strict-mcp-config",
  "--tools",
  "",
  "--output-format",
  "json",
  "--json-schema",
  SCHEMA,
  prompt,
];

/**
 * The model's environment: marked as the verdict's child, and outside any
 * cmux workspace, so a Stop hook there could not touch the move it judges.
 */
export function childEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env, [CHILD_ENV]: "1" };
  delete out.CMUX_WORKSPACE_ID;
  return out;
}

/** True when this process is the model's own, where the move hook must do nothing. */
export const isVerdictChild = (env: NodeJS.ProcessEnv): boolean => env[CHILD_ENV] === "1";

const waitingOf = (v: unknown): MoveVerdict | null => {
  const w = field(v, "waiting");
  return typeof w === "boolean" ? (w ? "waits" : "quiet") : null;
};

/**
 * The verdict in `claude -p --output-format json`'s output: its
 * `structured_output`, else its `result` read as JSON; null for an error
 * result or anything else.
 */
export function parseVerdict(stdout: string): MoveVerdict | null {
  let out: unknown;
  try {
    out = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (field(out, "is_error") === true) return null;
  const structured = waitingOf(field(out, "structured_output"));
  if (structured) return structured;
  const result = field(out, "result");
  if (typeof result !== "string") return null;
  try {
    return waitingOf(JSON.parse(result));
  } catch {
    return null;
  }
}

/** One run of `claude`: its exit status (null when killed), stdout, and whether the timeout killed it. */
export interface RunResult {
  status: number | null;
  stdout: string;
  timedOut: boolean;
}
export type Runner = (args: string[], env: NodeJS.ProcessEnv, timeoutMs: number) => RunResult;

/** The model's verdict on `reply`, or null when it failed, timed out or answered nothing usable. */
export function askModel(reply: string, run: Runner, env: NodeJS.ProcessEnv): MoveVerdict | null {
  const r = run(claudeArgs(verdictPrompt(reply)), childEnv(env), VERDICT_TIMEOUT_MS);
  return r.timedOut || r.status !== 0 ? null : parseVerdict(r.stdout);
}

// Runs from a temporary folder, so no project's CLAUDE.md or settings load.
const runClaude: Runner = (args, env, timeoutMs) => {
  const r = spawnSync("claude", args, {
    cwd: tmpdir(),
    env,
    timeout: timeoutMs,
    killSignal: "SIGKILL",
    stdio: ["ignore", "pipe", "ignore"],
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
  });
  const timedOut = r.error !== undefined && "code" in r.error && r.error.code === "ETIMEDOUT";
  return { status: r.status, stdout: r.stdout ?? "", timedOut };
};

/**
 * `current` with the verdict, when it is still the move a run was started
 * for (same epoch, session and text); null when it is gone or newer.
 */
export function withVerdict(
  current: SavedMove | null | undefined,
  target: VerdictTarget,
  verdict: MoveVerdict,
): SavedMove | null {
  if (!current) return null;
  if (current.epoch !== target.epoch || current.session !== target.session || current.text !== target.text) return null;
  return { ...current, verdict };
}

export interface VerdictDeps {
  read: (wsId: string) => DescriptionRead;
  write: (wsId: string, description: string) => boolean;
  saved: (wsId: string) => SavedMove | undefined;
  save: (wsId: string, move: SavedMove) => { ok: true; changed: boolean } | { ok: false; error: string };
  build: () => void;
  /** Runs `body` holding the workspace's description lock, `busy` when it stays taken. */
  locked: (wsId: string, body: () => string, busy: () => string) => string;
}

// Patches the description's move, keeping the context tail, and reads it
// back: one cmux cut or changed is put back as it was, so the move stands.
function patchDescription(wsId: string, before: string, move: SavedMove, d: VerdictDeps): string {
  const body = moveDescription(move);
  if (!d.write(wsId, withContext(body, splitContext(before).context))) return "cmux refused the description";
  const back = d.read(wsId);
  if (back.ok && splitContext(back.text).body === body) return "wrote the verdict to the description";
  d.write(wsId, before);
  return "cmux changed the description, so it was put back";
}

/**
 * Writes `verdict` onto the workspace's move, under the description lock
 * the move hook also holds: on the description's move when that is the
 * target, else on the saved map's (rebuilding when that changed it), else
 * nowhere, as the move has moved on. Says what happened, for the state log.
 */
export function applyVerdict(target: VerdictTarget, verdict: MoveVerdict, d: VerdictDeps): string {
  return d.locked(
    target.wsId,
    () => {
      const current = d.read(target.wsId);
      if (current.ok) {
        const patched = withVerdict(moveOfDescription(current.text), target, verdict);
        if (patched) return patchDescription(target.wsId, current.text, patched, d);
      }
      const patched = withVerdict(d.saved(target.wsId), target, verdict);
      if (!patched) return "the move is gone or newer";
      const result = d.save(target.wsId, patched);
      if (!result.ok) return `could not save: ${result.error}`;
      if (result.changed) d.build();
      return "wrote the verdict to the saved map";
    },
    () => "the description lock stayed taken",
  );
}

/** The arguments that start a verdict run for `target` on `reply`. */
export const verdictJob = (target: VerdictTarget, reply: string): string[] => [
  "--apply",
  JSON.stringify({ target, reply: reply.length > REPLY_CAP ? reply.slice(-REPLY_CAP) : reply }),
];

/** The target and reply a verdict run was started with, or null for bad arguments. */
export function jobOf(args: readonly string[]): { target: VerdictTarget; reply: string } | null {
  if (args[0] !== "--apply" || args[1] === undefined) return null;
  let v: unknown;
  try {
    v = JSON.parse(args[1]);
  } catch {
    return null;
  }
  const t = field(v, "target");
  const reply = field(v, "reply");
  const [wsId, epoch, session, text] = [field(t, "wsId"), field(t, "epoch"), field(t, "session"), field(t, "text")];
  if (typeof reply !== "string" || typeof wsId !== "string" || !isId(wsId)) return null;
  if (typeof epoch !== "number" || typeof text !== "string") return null;
  if (session !== undefined && typeof session !== "string") return null;
  return { target: { wsId, epoch, text, ...(typeof session === "string" ? { session } : {}) }, reply };
}

/**
 * Starts a verdict run for the move just saved, detached in its own process
 * group and unreferenced, since dispatch.ts kills each hook's group at 30s.
 */
export function startVerdict(target: VerdictTarget, reply: string): void {
  try {
    const child = spawn(process.execPath, [import.meta.filename, ...verdictJob(target, reply)], {
      cwd: tmpdir(),
      detached: true,
      stdio: "ignore",
    });
    child.on("error", (err) => logLine(`move-verdict could not start: ${err.message}`));
    child.unref();
  } catch (err) {
    logLine(`move-verdict could not start: ${err instanceof Error ? err.message : String(err)}`);
  }
}

const STATE_PATH = join(import.meta.dirname, "..", "..", "config", "state.json");

function savedMoveOf(wsId: string): SavedMove | undefined {
  try {
    const moves = validateState(JSON.parse(readFileSync(STATE_PATH, "utf8"))).moves;
    return Object.hasOwn(moves, wsId) ? moves[wsId] : undefined;
  } catch {
    return undefined;
  }
}

const REAL_DEPS: VerdictDeps = {
  read: readDescription,
  write: (wsId, description) => writeDescription("move-verdict", wsId, description),
  saved: savedMoveOf,
  save: (wsId, move) => readApplyWrite(STATE_PATH, `moves.${wsId}`, JSON.stringify(move)),
  build: () => scheduleBuild("move-verdict"),
  locked: (wsId, body, busy) => withDescriptionLock(wsId, 3000, body, busy),
};

/** A replay file's replies: each line a JSON string, or an object with `text`; other lines are skipped. */
export function repliesOf(file: string): string[] {
  const out: string[] = [];
  for (const line of file.split("\n")) {
    if (!line.trim()) continue;
    let v: unknown;
    try {
      v = JSON.parse(line);
    } catch {
      continue;
    }
    const text = typeof v === "string" ? v : field(v, "text");
    if (typeof text === "string") out.push(text);
  }
  return out;
}

function replay(path: string): void {
  repliesOf(readFileSync(path, "utf8")).forEach((reply, i) => {
    const verdict = askModel(reply, runClaude, process.env) ?? "none";
    const end = reply.trim().split("\n").at(-1) ?? "";
    console.log(`${i + 1}\t${verdict}\t${end.slice(0, 100)}`);
  });
}

function apply(args: readonly string[]): void {
  const job = jobOf(args);
  if (!job) {
    logLine("move-verdict got bad arguments");
    return;
  }
  const id = job.target.wsId.slice(0, 8);
  const verdict = askModel(job.reply, runClaude, process.env);
  if (!verdict) {
    logLine(`move-verdict for ${id}: no verdict from the model`);
    return;
  }
  logLine(`move-verdict for ${id}: ${verdict}, ${applyVerdict(job.target, verdict, REAL_DEPS)}`);
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  try {
    if (args[0] === "--replay" && args[1] !== undefined) replay(args[1]);
    else apply(args);
  } catch (err) {
    logLine(`move-verdict failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
