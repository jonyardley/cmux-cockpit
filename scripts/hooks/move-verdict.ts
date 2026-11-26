// A small model's verdict on a turn's final reply, written onto its saved move (docs/state-loop.md).

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

export const CHILD_ENV = "COCKPIT_VERDICT_CHILD";
export const VERDICT_TIMEOUT_MS = 20_000;
export const REPLY_CAP = 6000;

export interface VerdictTarget {
  wsId: string;
  epoch: number;
  session?: string;
  text: string;
}

export const verdictTarget = (wsId: string, m: SavedMove): VerdictTarget => ({
  wsId,
  epoch: m.epoch,
  text: m.text,
  ...(m.session !== undefined ? { session: m.session } : {}),
});

// The prompt

const SCHEMA = '{"type":"object","properties":{"waiting":{"type":"boolean"}},"required":["waiting"]}';
const OPEN = "<<<REPLY";
const CLOSE = "REPLY>>>";

// Looped, since cutting one marker can join its neighbours into another.
export function withoutMarkers(text: string): string {
  let out = text;
  for (;;) {
    const next = out.split(OPEN).join("").split(CLOSE).join("");
    if (next === out) return out;
    out = next;
  }
}

const cut = (reply: string): string => (reply.length > REPLY_CAP ? reply.slice(-REPLY_CAP) : reply);

export function verdictPrompt(reply: string): string {
  return [
    "The text between the markers is a coding agent's reply to its human, at the end of the agent's turn.",
    'Answer "waiting": true when the reply waits on the human now: it asks a question, offers options or a decision,',
    "asks for approval, a go, a review or a paste, or tells the human to do something now.",
    "A final line, often in bold, telling the human to do something now means waiting, even after",
    '"Nothing needed from you": "Paste this into ...", "Merge it", "Approve ...", "Attach the file and send it",',
    '"Name the next issue", "Reply with a letter". A line saying a pull request is ready for the human to merge',
    "is also waiting.",
    'Answer "waiting": false when it reports progress or says nothing is needed, even when it describes the',
    'agent\'s own next steps ("After it I push, open a draft PR, and ask for your word") or an ask that comes later.',
    'An action that is explicitly optional or for later is not waiting either: "Close this chat whenever you like",',
    '"Type /exit to close", "Open the card when it asks for your word", "Leave this card alone".',
    "",
    OPEN,
    withoutMarkers(cut(reply)),
    CLOSE,
  ].join("\n");
}

// The prompt goes on stdin, so a reply never reaches argv.
export const claudeArgs = (): string[] => [
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
];

// `claude` resolves to the cmux shim, whose wrapper adds cmux's hooks when
// CMUX_SURFACE_ID is set (cmux-claude-wrapper, "IN_CMUX"); its documented
// opt-out is CMUX_CLAUDE_HOOKS_DISABLED=1.
const CMUX_SURFACE = ["CMUX_WORKSPACE_ID", "CMUX_SURFACE_ID", "CMUX_TAB_ID", "CMUX_PANEL_ID", "CMUX_CLAUDE_PID"];

export function childEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env, [CHILD_ENV]: "1", CMUX_CLAUDE_HOOKS_DISABLED: "1" };
  for (const key of CMUX_SURFACE) delete out[key];
  return out;
}

export const isVerdictChild = (env: NodeJS.ProcessEnv): boolean => env[CHILD_ENV] === "1";

// The model's answer

const waitingOf = (v: unknown): MoveVerdict | null => {
  const w = field(v, "waiting");
  return typeof w === "boolean" ? (w ? "waits" : "quiet") : null;
};

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

export interface RunResult {
  status: number | null;
  stdout: string;
  timedOut: boolean;
}
export type Runner = (args: string[], input: string, env: NodeJS.ProcessEnv, timeoutMs: number) => RunResult;

export function askModel(reply: string, run: Runner, env: NodeJS.ProcessEnv): MoveVerdict | null {
  const r = run(claudeArgs(), verdictPrompt(reply), childEnv(env), VERDICT_TIMEOUT_MS);
  return r.timedOut || r.status !== 0 ? null : parseVerdict(r.stdout);
}

// Runs from a temporary folder, so no project's CLAUDE.md or settings load.
const runClaude: Runner = (args, input, env, timeoutMs) => {
  const r = spawnSync("claude", args, {
    cwd: tmpdir(),
    env,
    input,
    timeout: timeoutMs,
    killSignal: "SIGKILL",
    stdio: ["pipe", "pipe", "ignore"],
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
  });
  const timedOut = r.error !== undefined && "code" in r.error && r.error.code === "ETIMEDOUT";
  return { status: r.status, stdout: r.stdout ?? "", timedOut };
};

// Writing the verdict

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
  /** Sets the description, or clears it for null; false when cmux refused. */
  write: (wsId: string, description: string | null) => boolean;
  saved: (wsId: string) => SavedMove | undefined;
  save: (wsId: string, move: SavedMove) => { ok: true; changed: boolean } | { ok: false; error: string };
  build: () => void;
  locked: (wsId: string, body: () => string, busy: () => string) => string;
}

// Asks again once when cmux does not answer, as report-move's readTwice does.
function readTwice(wsId: string, d: VerdictDeps): DescriptionRead {
  const first = d.read(wsId);
  return !first.ok && first.why === "silent" ? d.read(wsId) : first;
}

// The saved map's move is read again just before the write, so a newer one
// saved meanwhile stands.
function saveMove(wsId: string, move: SavedMove, d: VerdictDeps, why: string): string {
  const there = d.saved(wsId);
  if (there && there.epoch > move.epoch) return `${why}, and a newer move is saved, so nothing was written`;
  const result = d.save(wsId, move);
  if (!result.ok) return `${why}, and it could not be saved: ${result.error}`;
  if (result.changed) d.build();
  return `${why}, so it went to the saved map`;
}

// The move hook's busy path writes without the lock and cmux has no
// compare-and-set, so each write follows a fresh read: a newer move that
// lands meanwhile is left alone. A cut description is taken off and the
// move saved, as report-move's describeMove does, since both readers prefer
// the description on equal epochs and a put-back move would hide the verdict.
function patchDescription(wsId: string, before: string, patched: SavedMove, d: VerdictDeps): string {
  const body = moveDescription(patched);
  if (!d.write(wsId, withContext(body, splitContext(before).context)))
    return saveMove(wsId, patched, d, "cmux refused the description");
  const back = readTwice(wsId, d);
  if (!back.ok) return "wrote the verdict to the description, unconfirmed: cmux did not answer the read-back";
  if (splitContext(back.text).body === body) return "wrote the verdict to the description";
  if (moveOfDescription(back.text) !== null) return "another move took the description, so it was left";
  const now = readTwice(wsId, d);
  if (!now.ok || now.text !== back.text) return "cmux changed the description, then it changed again, so it was left";
  const context = splitContext(now.text).context ?? splitContext(before).context;
  d.write(wsId, context ? withContext("", context) : null);
  return saveMove(wsId, patched, d, "cmux changed the description");
}

function land(target: VerdictTarget, verdict: MoveVerdict, d: VerdictDeps): string {
  const current = readTwice(target.wsId, d);
  if (current.ok) {
    const patched = withVerdict(moveOfDescription(current.text), target, verdict);
    if (patched) return patchDescription(target.wsId, current.text, patched, d);
  }
  const patched = withVerdict(d.saved(target.wsId), target, verdict);
  if (!patched)
    return current.ok || current.why === "unlisted"
      ? "the move is gone or newer"
      : "cmux did not answer the read, twice, and the saved map does not hold the move";
  const result = d.save(target.wsId, patched);
  if (!result.ok) return `could not save: ${result.error}`;
  if (result.changed) d.build();
  return "wrote the verdict to the saved map";
}

export const applyVerdict = (target: VerdictTarget, verdict: MoveVerdict, d: VerdictDeps): string =>
  d.locked(
    target.wsId,
    () => land(target, verdict, d),
    () => "the description lock stayed taken",
  );

// Starting a run

export const verdictJob = (target: VerdictTarget, reply: string): string =>
  JSON.stringify({ target, reply: cut(reply) });

export function jobOf(input: string): { target: VerdictTarget; reply: string } | null {
  let v: unknown;
  try {
    v = JSON.parse(input);
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

// Detached in its own process group, since dispatch.ts kills each hook's
// group at 30s. The job goes on stdin, so the reply never reaches argv.
export function startVerdict(target: VerdictTarget, reply: string): void {
  const failed = (err: unknown) =>
    logLine(`move-verdict could not start: ${err instanceof Error ? err.message : String(err)}`);
  try {
    const child = spawn(process.execPath, [import.meta.filename, "--apply"], {
      cwd: tmpdir(),
      detached: true,
      stdio: ["pipe", "ignore", "ignore"],
    });
    child.on("error", failed);
    child.stdin.on("error", failed);
    child.stdin.end(verdictJob(target, reply));
    child.unref();
  } catch (err) {
    failed(err);
  }
}

// Running it

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

// `--replay <file>`: JSON lines of past replies, each verdict printed, to
// set the model against the wording rules.
function replay(path: string): void {
  repliesOf(readFileSync(path, "utf8")).forEach((reply, i) => {
    const verdict = askModel(reply, runClaude, process.env) ?? "none";
    const end = reply.trim().split("\n").at(-1) ?? "";
    console.log(`${i + 1}\t${verdict}\t${end.slice(0, 100)}`);
  });
}

function apply(): void {
  const job = jobOf(readFileSync(0, "utf8"));
  if (!job) {
    logLine("move-verdict got a bad job");
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
    else if (args[0] === "--apply") apply();
    else logLine("move-verdict got bad arguments");
  } catch (err) {
    logLine(`move-verdict failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
