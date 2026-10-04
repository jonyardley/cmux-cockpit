// Tells cmux about a workspace's subagent runs (#6): custom sidebars get no
// subagent data from cmux at all, so this hook is the only source.
//
// Run by scripts/hooks/dispatch.ts on three Claude Code events, as
// scripts/hooks/routes.ts lists them: PreToolUse (matcher "Agent"),
// SubagentStart and SubagentStop. Each invocation gets one event as JSON
// on stdin and the workspace id from CMUX_WORKSPACE_ID, and folds it into
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
// fresh run, a Start for an agent already saved reopens its row (a resume),
// and a run that never gets a Stop is pruned once it has run
// for too long (scripts/subagent-runs.ts).
//
// Residual case (docs/state-loop.md): a denied or failed Agent call is
// never followed by a SubagentStart, so its row sits unpaired until it is
// pruned. A second call of the same subagent_type approved within that
// window still pairs to the denied call's row first, since nothing here
// can tell the two apart beyond session and type.
//
// A visible change schedules a rebuild through scripts/hook-build.ts, which
// coalesces events that land close together into one build.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { scheduleLateBuild } from "../hook-build.ts";
import { labelFrom, type SavedSubagent, type State, validateState } from "../state-config.ts";
import { writeSubagents } from "../state-url.ts";
import { prune } from "../subagent-runs.ts";

// Re-exported so this hook stays the one place both its own tests and
// pr-poll.ts's need to reach the retention policy from.
export { prune };

type SubagentMap = State["subagents"];

function field(obj: unknown, key: string): unknown {
  return typeof obj === "object" && obj !== null && key in obj ? Reflect.get(obj, key) : undefined;
}

// A run's type, kept only when it is a non-empty string: cleanLabel's rules
// do not apply here, since this is compared for equality, not shown.
function typeOf(raw: unknown): string | undefined {
  return typeof raw === "string" && raw ? raw : undefined;
}

// PreToolUse on the Agent tool: a new run, keyed by the call, not yet paired
// to an agent id. A duplicate delivery of the same call (the entry point
// can be installed twice, or an event can be redelivered) is a no-op: a run with
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
  const label = labelFrom("subagent", field(input, "description"), subagentType);
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
  if (runs.some((r) => r.agentId === agentId)) return onResume(runs, agentId, session, now);
  const type = typeOf(agentType);
  const unpaired = (r: SavedSubagent): boolean => r.session === session && r.agentId === undefined;
  const byType = type ? runs.findIndex((r) => unpaired(r) && r.type === type) : -1;
  const index = byType !== -1 ? byType : runs.findIndex(unpaired);
  if (index === -1) {
    const label = labelFrom("subagent", agentType);
    return [...runs, { id: agentId, session, agentId, label, startedEpoch: now, ...(type ? { type } : {}) }];
  }
  return runs.map((r, i) => (i === index ? { ...r, agentId } : r));
}

// A row for this agent that has not ended yet.
const openFor =
  (agentId: string) =>
  (r: SavedSubagent): boolean =>
    r.agentId === agentId && r.endedEpoch === undefined;

/** A Start this soon after the agent's Stop is a late or duplicate delivery
 * of the first Start, not a resume: a resume needs the parent to read the
 * result and send a message, which takes longer than this. */
export const RESUME_MIN_GAP_S = 5;

// A second SubagentStart for an agent id already saved is a resume: a
// SendMessage to a finished background agent starts it again under the same
// id. The newest row for that agent runs again from now under the resuming
// session, keeping its label, rather than a fresh row being added beside it;
// before this, the Stop that followed found the first, already ended row, so
// the fresh one never ended and a helper counted as live for two hours. The
// row moves to the end, since MAX_SUBAGENTS keeps the last rows. A Start
// while a row for that agent is still open, or within RESUME_MIN_GAP_S of
// its Stop, is a duplicate delivery, a no-op.
function onResume(runs: SavedSubagent[], agentId: string, session: string, now: number): SavedSubagent[] {
  if (runs.some(openFor(agentId))) return runs;
  const index = runs.findLastIndex((r) => r.agentId === agentId);
  const row = runs[index];
  if (!row || now - (row.endedEpoch ?? now) < RESUME_MIN_GAP_S) return runs;
  const { endedEpoch, ...open } = row;
  return [...runs.filter((_, i) => i !== index), { ...open, session, startedEpoch: now }];
}

// SubagentStop: every run with that agentId still open, wherever it is, ends
// now, so rows a resume added before onResume existed close too. A miss (no
// open run has it, as with a duplicate delivery of the same Stop) returns
// runs unchanged rather than an equal-looking copy or a bumped endedEpoch.
function onSubagentStop(runs: SavedSubagent[], event: unknown, now: number): SavedSubagent[] {
  const agentId = field(event, "agent_id");
  if (typeof agentId !== "string") return runs;
  const open = openFor(agentId);
  if (!runs.some(open)) return runs;
  return runs.map((r) => (open(r) ? { ...r, endedEpoch: now } : r));
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
  if (changed) scheduleLateBuild("report-subagent");
}

if (import.meta.main) await main();
