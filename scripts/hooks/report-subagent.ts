// Tells cmux about a workspace's subagent runs (#6): custom sidebars get no
// subagent data from cmux at all, so this hook is the only source.
//
// Run as a Claude Code hook on three events (docs/state-loop.md has the
// settings.json block): PreToolUse (matcher "Agent"), SubagentStart and
// SubagentStop. Each invocation gets one event as JSON on stdin and the
// workspace id from CMUX_WORKSPACE_ID, and folds it into
// config/state.json's `subagents` map (scripts/state-config.ts) under the
// same file lock a URL write or a PR poll uses (state-url.ts's
// writeSubagents). It never fails the hook: a missing workspace id, bad
// JSON or an event it does not recognise is a quiet exit 0; anything else
// wrong goes to stderr.
//
// A run is keyed by the Agent tool call (PreToolUse's tool_use_id) so it
// exists before Claude Code has an agent id for it; SubagentStart pairs it
// up by giving the oldest unpaired run in that session an agentId, and
// SubagentStop finds it by that agentId. Nothing here is fatal if an event
// is missed: SubagentStart falls back to appending a fresh run, and a run
// that never gets a Stop is pruned once it has run for too long.
//
// Rebuilding both sidebars costs a full esbuild pass, so two events close
// together (SubagentStart fires ~25ms after the PreToolUse that starts the
// same run, and independent subagents can start together) should not each
// spawn their own build. This coalesces them with a lockfile in config/:
// the first event to see no build in flight takes the lock and spawns a
// detached run of itself with --coalesce-build, which sleeps briefly (so a
// near-simultaneous second write lands before the build reads the file),
// runs scripts/build.ts, and only then drops the lock; every other event in
// that window sees the lock held and does nothing, trusting the build that
// holds it to pick up its write once it runs. A lock older than
// BUILD_LOCK_STALE_MS is a crashed build's and is retaken.

import { spawn, spawnSync } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { MAX_LABEL, type SavedSubagent, type State } from "../state-config.ts";
import { LOG_PATH } from "../state-log.ts";
import { writeSubagents } from "../state-url.ts";

type SubagentMap = State["subagents"];

function field(obj: unknown, key: string): unknown {
  return typeof obj === "object" && obj !== null && key in obj ? Reflect.get(obj, key) : undefined;
}

// Control characters are turned to spaces by code point rather than a regex
// literal (Biome disallows one; state-config.ts's isName does the same).
function dropControl(raw: string): string {
  return [...raw].map((c) => (c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127 ? " " : c)).join("");
}

/** Collapses whitespace and control characters and cuts to MAX_LABEL, or null for anything unusable. */
function cleanLabel(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const cleaned = dropControl(raw).replaceAll(/\s+/g, " ").trim();
  return cleaned.length ? cleaned.slice(0, MAX_LABEL) : null;
}

/** The first candidate that cleans up to something, else "subagent". */
function labelFrom(...candidates: unknown[]): string {
  for (const candidate of candidates) {
    const cleaned = cleanLabel(candidate);
    if (cleaned) return cleaned;
  }
  return "subagent";
}

// PreToolUse on the Agent tool: a new run, keyed by the call, not yet paired
// to an agent id.
// A run this function leaves unchanged returns the same array reference,
// so applyEvent can tell a no-op from a real change without a deep compare.
function onPreToolUse(runs: SavedSubagent[], event: unknown, now: number): SavedSubagent[] {
  if (field(event, "tool_name") !== "Agent") return runs;
  const toolUseId = field(event, "tool_use_id");
  const session = field(event, "session_id");
  if (typeof toolUseId !== "string" || typeof session !== "string") return runs;
  const input = field(event, "tool_input");
  const label = labelFrom(field(input, "description"), field(input, "subagent_type"));
  return [...runs, { id: toolUseId, session, label, startedEpoch: now }];
}

// SubagentStart: gives the oldest run in that session with no agentId the
// agent id Claude Code just gave it. When PreToolUse was missed (no such
// run), it appends one instead, labelled from agent_type since there is no
// description to prefer.
function onSubagentStart(runs: SavedSubagent[], event: unknown, now: number): SavedSubagent[] {
  const agentId = field(event, "agent_id");
  const session = field(event, "session_id");
  if (typeof agentId !== "string" || typeof session !== "string") return runs;
  const index = runs.findIndex((r) => r.session === session && r.agentId === undefined);
  if (index === -1) {
    const label = labelFrom(field(event, "agent_type"));
    return [...runs, { id: agentId, session, agentId, label, startedEpoch: now }];
  }
  return runs.map((r, i) => (i === index ? { ...r, agentId } : r));
}

// SubagentStop: the run with that agentId, wherever it is, ends now. A miss
// (no run has it) returns runs unchanged rather than an equal-looking copy.
function onSubagentStop(runs: SavedSubagent[], event: unknown, now: number): SavedSubagent[] {
  const agentId = field(event, "agent_id");
  if (typeof agentId !== "string" || !runs.some((r) => r.agentId === agentId)) return runs;
  return runs.map((r) => (r.agentId === agentId ? { ...r, endedEpoch: now } : r));
}

/** Folds one hook event into a workspace's runs. An event this hook does not know is a no-op. */
export function applyEvent(map: SubagentMap, wsId: string, event: unknown, now: number): SubagentMap {
  const runs = map[wsId] ?? [];
  const hookName = field(event, "hook_event_name");
  const next =
    hookName === "PreToolUse"
      ? onPreToolUse(runs, event, now)
      : hookName === "SubagentStart"
        ? onSubagentStart(runs, event, now)
        : hookName === "SubagentStop"
          ? onSubagentStop(runs, event, now)
          : runs;
  return next === runs ? map : { ...map, [wsId]: next };
}

// A crashed agent never sends SubagentStop, so a running run is dropped once
// it is plainly stale rather than kept forever; a settled one is dropped
// once the sidebar has had a good while to show it.
const RUNNING_MAX_AGE_S = 2 * 60 * 60;
const ENDED_MAX_AGE_S = 10 * 60;

/** Drops stale runs across every workspace, and any workspace left with none. */
export function prune(map: SubagentMap, now: number): SubagentMap {
  const out: SubagentMap = {};
  for (const [wsId, runs] of Object.entries(map)) {
    const kept = runs.filter((r) =>
      r.endedEpoch === undefined ? now - r.startedEpoch <= RUNNING_MAX_AGE_S : now - r.endedEpoch <= ENDED_MAX_AGE_S,
    );
    if (kept.length) out[wsId] = kept;
  }
  return out;
}

// agentId is bookkeeping for pairing a Start to its PreToolUse row; the
// sidebar never shows it (src/shared/subagents.ts), so pairing one on its
// own must not cost a rebuild.
function withoutAgentId(run: SavedSubagent): Omit<SavedSubagent, "agentId"> {
  const { agentId, ...rest } = run;
  return rest;
}

/** Whether the sidebar would draw something different, ignoring agentId alone changing. */
export function visibleChange(before: SubagentMap, after: SubagentMap): boolean {
  const strip = (map: SubagentMap) =>
    JSON.stringify(Object.fromEntries(Object.entries(map).map(([id, runs]) => [id, runs.map(withoutAgentId)])));
  return strip(before) !== strip(after);
}

const ROOT = join(import.meta.dirname, "..", "..");
const STATE_PATH = join(ROOT, "config", "state.json");
const BUILD_LOCK = join(ROOT, "config", "subagent-build.lock");
const COALESCE_MS = 300;
const BUILD_LOCK_STALE_MS = 60_000;
const BUILD_TIMEOUT_MS = 60_000;

function logFd(): number | "ignore" {
  try {
    return openSync(LOG_PATH, "a");
  } catch {
    return "ignore";
  }
}

// Exclusive lockfile, the same shape as pr-poll.ts's and state-url.ts's: a
// stale one (older than a build could plausibly take) is a crashed build's.
function tryTakeBuildLock(): boolean {
  mkdirSync(join(ROOT, "config"), { recursive: true });
  try {
    closeSync(openSync(BUILD_LOCK, "wx"));
    return true;
  } catch {
    const age = Date.now() - (statSync(BUILD_LOCK, { throwIfNoEntry: false })?.mtimeMs ?? Date.now());
    if (age <= BUILD_LOCK_STALE_MS) return false;
    try {
      rmSync(BUILD_LOCK, { force: true });
      closeSync(openSync(BUILD_LOCK, "wx"));
      return true;
    } catch {
      return false;
    }
  }
}

// The detached side of the coalesce: sleeps so a near-simultaneous write
// lands first, builds, then drops the lock so the next visible change can
// schedule its own build.
async function coalesceBuild(): Promise<void> {
  await sleep(COALESCE_MS);
  const build = spawnSync(process.execPath, ["scripts/build.ts"], {
    cwd: ROOT,
    stdio: "ignore",
    timeout: BUILD_TIMEOUT_MS,
  });
  if (build.status !== 0) console.error("report-subagent: build failed");
  rmSync(BUILD_LOCK, { force: true });
}

// Spawns the coalescing build detached and unreferenced, so the hook returns
// at once; skips spawning when one is already in flight.
function scheduleBuild(): void {
  if (!tryTakeBuildLock()) return;
  const log = logFd();
  try {
    const child = spawn(process.execPath, [import.meta.filename, "--coalesce-build"], {
      cwd: ROOT,
      detached: true,
      stdio: ["ignore", "ignore", log],
    });
    child.on("error", (err) => {
      console.error(`report-subagent: build: ${err.message}`);
      rmSync(BUILD_LOCK, { force: true });
    });
    child.unref();
  } catch (err) {
    console.error(`report-subagent: build: ${err instanceof Error ? err.message : String(err)}`);
    rmSync(BUILD_LOCK, { force: true });
  } finally {
    if (log !== "ignore") closeSync(log);
  }
}

async function main(): Promise<void> {
  const wsId = process.env.CMUX_WORKSPACE_ID;
  if (!wsId) return;
  let event: unknown;
  try {
    event = JSON.parse(readFileSync(0, "utf8"));
  } catch {
    return;
  }
  const now = Math.floor(Date.now() / 1000);
  let before: SubagentMap = {};
  let after: SubagentMap = {};
  let result: ReturnType<typeof writeSubagents>;
  try {
    result = writeSubagents(STATE_PATH, (subagents) => {
      before = subagents;
      after = prune(applyEvent(subagents, wsId, event, now), now);
      return after;
    });
  } catch (err) {
    console.error(`report-subagent: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  if (!result.ok) return console.error(`report-subagent: ${result.error}`);
  if (visibleChange(before, after)) scheduleBuild();
}

if (import.meta.main) {
  if (process.argv[2] === "--coalesce-build") await coalesceBuild();
  else await main();
}
