// A workspace's subagent runs from the saved state (issue #6): cmux sends
// custom sidebars no subagents, so scripts/hooks/report-subagent.ts records
// them in config/state.json. The agents model reads them through here while
// no agent carries cmux's own `children`, so cmux's data wins the day it
// sends any.

import { agentsOf } from "./needs.ts";
import { SAVED_STATE } from "./persist.ts";

/** A saved run, shaped as renderer.d.ts's SubagentRun, plus its session. */
export interface SavedRun extends SubagentRun {
  /** The Claude Code session that called it, to match an agent by id. */
  session: string;
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

/** How many subagent runs are live in the workspace: cmux's own `children`
 * while any agent carries a real one, else the saved runs. */
export function liveRunCount(w: Workspace | undefined): number {
  if (!w) return 0;
  const agents = agentsOf(w);
  if (agents.some((a) => (a.children ?? []).some((c) => c))) {
    return agents.reduce((n, a) => n + (a.children ?? []).filter((c) => c && childRunning(c, a)).length, 0);
  }
  return savedRuns(w.id).filter((run) => savedRunning(run, agents)).length;
}
