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
// up by giving the oldest unpaired run in that session, whose saved `type`
// matches the event's agent_type, an agentId (falling back to the oldest
// unpaired run in the session when none matches, since that is still the
// best guess), and SubagentStop finds it by that agentId. Nothing here is
// fatal if an event is missed: SubagentStart falls back to appending a
// fresh run, and a run that never gets a Stop is pruned once it has run
// for too long (scripts/subagent-runs.ts).
//
// Residual case (docs/state-loop.md): a denied or failed Agent call is
// never followed by a SubagentStart, so its row sits unpaired until it is
// pruned. A second call of the same subagent_type approved within that
// window still pairs to the denied call's row first, since nothing here
// can tell the two apart beyond session and type.
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
import { MAX_LABEL, type SavedSubagent, type State, validateState } from "../state-config.ts";
import { LOG_PATH } from "../state-log.ts";
import { writeSubagents } from "../state-url.ts";
import { prune } from "../subagent-runs.ts";

// Re-exported so this hook stays the one place both its own tests and
// pr-poll.ts's need to reach the retention policy from.
export { prune };

type SubagentMap = State["subagents"];

function field(obj: unknown, key: string): unknown {
  return typeof obj === "object" && obj !== null && key in obj ? Reflect.get(obj, key) : undefined;
}

// Control characters are turned to spaces by code point rather than a regex
// literal (Biome disallows one; state-config.ts's isName does the same).
function dropControl(raw: string): string {
  return [...raw].map((c) => (c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127 ? " " : c)).join("");
}

/**
 * Collapses whitespace and control characters, cuts to MAX_LABEL code
 * points (Array.from, so a surrogate pair is never split in two), and only
 * then trims: trimming first and slicing after can cut a label right after
 * a space, leaving a trailing space that isLabel then refuses and
 * validateState drops the whole run over. Null for anything unusable.
 */
function cleanLabel(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const collapsed = dropControl(raw).replaceAll(/\s+/g, " ");
  const cleaned = Array.from(collapsed).slice(0, MAX_LABEL).join("").trim();
  return cleaned.length ? cleaned : null;
}

/** The first candidate that cleans up to something, else "subagent". */
function labelFrom(...candidates: unknown[]): string {
  for (const candidate of candidates) {
    const cleaned = cleanLabel(candidate);
    if (cleaned) return cleaned;
  }
  return "subagent";
}

// A run's type, kept only when it is a non-empty string: cleanLabel's rules
// do not apply here, since this is compared for equality, not shown.
function typeOf(raw: unknown): string | undefined {
  return typeof raw === "string" && raw ? raw : undefined;
}

// PreToolUse on the Agent tool: a new run, keyed by the call, not yet paired
// to an agent id. A duplicate delivery of the same call (the hook can be
// registered twice, or an event can be redelivered) is a no-op: a run with
// that tool_use_id already exists.
// A run this function leaves unchanged returns the same array reference,
// so applyEvent can tell a no-op from a real change without a deep compare.
function onPreToolUse(runs: SavedSubagent[], event: unknown, now: number): SavedSubagent[] {
  if (field(event, "tool_name") !== "Agent") return runs;
  const toolUseId = field(event, "tool_use_id");
  const session = field(event, "session_id");
  if (typeof toolUseId !== "string" || typeof session !== "string") return runs;
  if (runs.some((r) => r.id === toolUseId)) return runs;
  const input = field(event, "tool_input");
  const subagentType = field(input, "subagent_type");
  const label = labelFrom(field(input, "description"), subagentType);
  const type = typeOf(subagentType);
  return [...runs, { id: toolUseId, session, label, startedEpoch: now, ...(type ? { type } : {}) }];
}

// SubagentStart: gives the oldest run in that session with no agentId yet,
// and whose saved `type` matches this event's agent_type, the agent id
// Claude Code just gave it; when nothing matches by type (or no run in the
// session carries one, e.g. PreToolUse missed it), it falls back to the
// oldest unpaired run in the session, the best guess left. When PreToolUse
// was missed for every call in the session, it appends a run instead,
// labelled from agent_type since there is no description to prefer.
function onSubagentStart(runs: SavedSubagent[], event: unknown, now: number): SavedSubagent[] {
  const agentId = field(event, "agent_id");
  const session = field(event, "session_id");
  const agentType = field(event, "agent_type");
  if (typeof agentId !== "string" || typeof session !== "string") return runs;
  const type = typeOf(agentType);
  const unpaired = (r: SavedSubagent): boolean => r.session === session && r.agentId === undefined;
  const byType = type ? runs.findIndex((r) => unpaired(r) && r.type === type) : -1;
  const index = byType !== -1 ? byType : runs.findIndex(unpaired);
  if (index === -1) {
    const label = labelFrom(agentType);
    return [...runs, { id: agentId, session, agentId, label, startedEpoch: now, ...(type ? { type } : {}) }];
  }
  return runs.map((r, i) => (i === index ? { ...r, agentId } : r));
}

// SubagentStop: the run with that agentId, wherever it is, ends now. A miss
// (no run has it), or one that already has an endedEpoch (a duplicate
// delivery of the same Stop), returns runs unchanged rather than an
// equal-looking copy or a bumped endedEpoch.
function onSubagentStop(runs: SavedSubagent[], event: unknown, now: number): SavedSubagent[] {
  const agentId = field(event, "agent_id");
  if (typeof agentId !== "string") return runs;
  const index = runs.findIndex((r) => r.agentId === agentId);
  if (index === -1 || runs[index]?.endedEpoch !== undefined) return runs;
  return runs.map((r, i) => (i === index ? { ...r, endedEpoch: now } : r));
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
// Exported so a test can check the stale threshold sits comfortably above
// this delay plus the timeout, without duplicating the figures.
export const COALESCE_MS = 300;
export const BUILD_TIMEOUT_MS = 60_000;
// Comfortably above the coalesce delay plus how long a build may run (2x
// the timeout), so a build that is genuinely still going, including a
// second pass buildUntilStable takes for a write that landed mid-build, is
// never mistaken for a crashed one's and retaken out from under it.
export const BUILD_LOCK_STALE_MS = 2 * BUILD_TIMEOUT_MS;

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

/**
 * Runs `build` at least once, and again each time `snapshot` reads
 * differently from what it was before the previous run: a write that
 * lands while a build is going (the lock is held, so its own event skips
 * scheduling one) is otherwise never built at all, since nothing else
 * schedules a build for it. Stops once a build fails, since retrying an
 * unchanged, already-failing build would not help; stops once two
 * successive snapshots agree, since nothing has changed since that build
 * started. Exported for testing with fakes instead of a real spawn and file.
 */
export function buildUntilStable(build: () => boolean, snapshot: () => string | null): void {
  let before = snapshot();
  for (;;) {
    if (!build()) return;
    const after = snapshot();
    if (after === before) return;
    before = after;
  }
}

function stateSnapshot(): string | null {
  try {
    return readFileSync(STATE_PATH, "utf8");
  } catch {
    return null;
  }
}

function runBuild(): boolean {
  const build = spawnSync(process.execPath, ["scripts/build.ts"], {
    cwd: ROOT,
    stdio: "ignore",
    timeout: BUILD_TIMEOUT_MS,
  });
  if (build.status === 0) return true;
  console.error("report-subagent: build failed");
  return false;
}

// The detached side of the coalesce: sleeps so a near-simultaneous write
// lands first, then builds until the state file stops changing under it,
// then drops the lock so the next visible change can schedule its own
// build.
async function coalesceBuild(): Promise<void> {
  await sleep(COALESCE_MS);
  buildUntilStable(runBuild, stateSnapshot);
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

/**
 * Applies one event and prunes, then validates both the before and after
 * maps the same way the write does (State validation and MAX_SUBAGENTS,
 * not only applyEvent's own rules) before comparing them: an entry that
 * the write's own validateState would reshape or drop must never be
 * counted as a visible change against a raw map that never reflects that.
 * Exported for testing.
 */
export function processEvent(
  subagents: SubagentMap,
  wsId: string,
  event: unknown,
  now: number,
): { before: SubagentMap; after: SubagentMap; changed: boolean } {
  const before = validateState({ subagents }).subagents;
  const after = validateState({ subagents: prune(applyEvent(subagents, wsId, event, now), now) }).subagents;
  return { before, after, changed: visibleChange(before, after) };
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
  let changed = false;
  let result: ReturnType<typeof writeSubagents>;
  try {
    result = writeSubagents(STATE_PATH, (subagents) => {
      const applied = processEvent(subagents, wsId, event, now);
      changed = applied.changed;
      return applied.after;
    });
  } catch (err) {
    console.error(`report-subagent: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  if (!result.ok) return console.error(`report-subagent: ${result.error}`);
  if (changed) scheduleBuild();
}

if (import.meta.main) {
  if (process.argv[2] === "--coalesce-build") await coalesceBuild();
  else await main();
}
