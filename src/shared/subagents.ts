// A workspace's subagent runs from the saved state (issue #6): cmux sends
// custom sidebars no subagents, so scripts/hooks/report-subagent.ts records
// them in config/state.json. The agents model reads them through here while
// no agent carries cmux's own `children`; once cmux sends any, its data is
// the list, and a saved run still live corrects it (pairLive, #83).

import { agentsOf } from "./needs.ts";
import { SAVED_STATE } from "./persist.ts";

/** A saved run, shaped as renderer.d.ts's SubagentRun, plus its session. */
export interface SavedRun extends SubagentRun {
  /** The Claude Code session that called it, to match an agent by id. */
  session: string;
  /** Claude Code's id for the running agent, once SubagentStart paired it. */
  agentId?: string;
}

/** The workspace's saved runs, oldest first; none when it has none. */
export function savedRuns(wsId: string): SavedRun[] {
  // A test can seed __STATE__ from before this field existed, so the map
  // itself may be missing at runtime even though State says it is not.
  const map = SAVED_STATE.subagents;
  const list = map && Object.hasOwn(map, wsId) ? map[wsId] : undefined;
  if (!list) return [];
  return list.map((s) => ({
    id: s.id,
    session: s.session,
    label: s.label,
    startedEpoch: s.startedEpoch,
    ...(s.agentId === undefined ? {} : { agentId: s.agentId }),
    // `running` is left unset: model.ts's savedRanked works it out itself
    // from the run's session and its owning agent's status, so a stale
    // value here would only ever be ignored, never shown.
    // Left out rather than set to undefined: exactOptionalPropertyTypes.
    ...(s.endedEpoch === undefined ? {} : { endedEpoch: s.endedEpoch }),
  }));
}

// Upstream always sends `running`; without it, a run with no end is live. A
// run under an ended session is over whatever it says. The same rules as
// src/agents/model.ts's isRunning and savedRanked, which can move onto these.
const childRunning = (c: SubagentRun, owner: Agent): boolean =>
  owner.status !== "ended" && (c.running ?? !c.endedEpoch);

// A saved run's owner is the agent whose id matches its session; with none,
// it is live while it has no end and any workspace agent is still live.
function savedRunning(run: SavedRun, agents: Agent[]): boolean {
  if (run.endedEpoch !== undefined) return false;
  const owner = agents.find((a) => a.id === run.session);
  return owner ? owner.status !== "ended" : agents.some((a) => a.status !== "ended");
}

/** cmux's children beside the saved runs (#83). cmux can settle a background
 * subagent the moment its Agent call returns, while the hook's saved run,
 * paired and with no end under a live owner, knows it is still going. Each
 * such saved run vouches for the one child that is the same run (by the
 * Agent call's id or the agent id, whichever cmux keys by, else by label),
 * and a live saved run no child claims is one cmux has already pruned. A
 * saved run with an end vouches for nothing, so a run the hook ended stays
 * as cmux says. */
export function pairLive(wsId: string, agents: Agent[]): { vouched: Set<SubagentRun>; unclaimed: SavedRun[] } {
  const unclaimed = savedRuns(wsId).filter((run) => savedRunning(run, agents));
  const vouched = new Set<SubagentRun>();
  for (const c of agents.flatMap((a) => a.children ?? [])) {
    if (!c) continue;
    const i = unclaimed.findIndex((run) => sameRun(run, c));
    if (i === -1) continue;
    unclaimed.splice(i, 1);
    vouched.add(c);
  }
  return { vouched, unclaimed };
}

// Unconfirmed which id cmux gives a child, so either of the hook's ids
// counts; the label is the fallback when cmux's id is its own.
function sameRun(run: SavedRun, c: SubagentRun): boolean {
  if (c.id !== undefined && (c.id === run.id || c.id === run.agentId)) return true;
  const label = c.label?.trim();
  return !!label && label === run.label?.trim();
}

/** How many subagent runs are live in the workspace: cmux's own `children`
 * while any agent carries a real one, each counted live when cmux says so or
 * a saved run vouches for it, plus the live saved runs no child claims;
 * else the saved runs. */
export function liveRunCount(w: Workspace | undefined): number {
  if (!w) return 0;
  const agents = agentsOf(w);
  if (agents.some((a) => (a.children ?? []).some((c) => c))) {
    const { vouched, unclaimed } = pairLive(w.id, agents);
    const live = (c: SubagentRun, a: Agent): boolean => childRunning(c, a) || vouched.has(c);
    return agents.reduce((n, a) => n + (a.children ?? []).filter((c) => c && live(c, a)).length, unclaimed.length);
  }
  return savedRuns(w.id).filter((run) => savedRunning(run, agents)).length;
}
