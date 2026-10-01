// A workspace's subagent runs from the saved state (issue #6): cmux sends
// custom sidebars no subagents, so scripts/hooks/report-subagent.ts records
// them in config/state.json. The agents model reads them through here while
// no agent carries cmux's own `children`; once cmux sends any, its data is
// the list, and a saved run still live corrects it (pairLive, #83).

import { agentsOf } from "./needs.ts";
import { SAVED_STATE } from "./persist.ts";
import { readable } from "./text.ts";

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
    // `running` is left unset: team.ts's savedRanked works it out itself
    // from the run's session and its owning agent's status, so a stale
    // value here would only ever be ignored, never shown.
    // Left out rather than set to undefined: exactOptionalPropertyTypes.
    ...(s.endedEpoch === undefined ? {} : { endedEpoch: s.endedEpoch }),
  }));
}

// Upstream always sends `running`; without it, a run with no end is live. A
// run under an ended session is over whatever it says. src/agents/team.ts
// ranks by these too, so the two sidebars never disagree.
export const childRunning = (c: SubagentRun, owner: Agent): boolean =>
  owner.status !== "ended" && (c.running ?? !c.endedEpoch);

/** A saved run's owner is the agent whose id matches its session; with none,
 * it is live while it has no end and any workspace agent is still live. */
export function savedRunning(run: SavedRun, agents: Agent[]): boolean {
  if (run.endedEpoch !== undefined) return false;
  const owner = agents.find((a) => a.id === run.session);
  return owner ? owner.status !== "ended" : agents.some((a) => a.status !== "ended");
}

interface Child {
  c: SubagentRun;
  owner: Agent;
}

// Unconfirmed which id cmux gives a child, so either of the hook's ids counts.
const sameId = (run: SavedRun, c: SubagentRun): boolean =>
  c.id !== undefined && (c.id === run.id || c.id === run.agentId);

// The fallback when cmux's id is its own: the label as drawn, never the
// generic "subagent" many runs share.
function sameLabel(run: SavedRun, c: SubagentRun): boolean {
  const label = readable(c.label);
  return label !== "" && label !== "subagent" && label === readable(run.label);
}

// A run whose session is a workspace agent's pairs only with that agent's
// children; one with no such agent may pair with any.
const mayPair = (run: SavedRun, owner: Agent, agents: Agent[]): boolean =>
  run.session === owner.id || !agents.some((a) => a.id === run.session);

/** cmux's children beside the saved runs (#83). cmux can settle a background
 * subagent the moment its Agent call returns, while the hook's saved run,
 * with no end under a live owner, knows it is still going. Each such saved
 * run claims the one child that is the same run, by id first and then by
 * label, so a finished run sharing a label never takes a live run from its
 * own child; the claim vouches for the child unless the child's owner has
 * ended. A live saved run no child claims is one cmux has already pruned. A
 * saved run with an end claims nothing, so a run the hook ended stays as
 * cmux says. */
export function pairLive(wsId: string, agents: Agent[]): { vouched: Set<SubagentRun>; unclaimed: SavedRun[] } {
  const unclaimed = savedRuns(wsId).filter((run) => savedRunning(run, agents));
  const children: Child[] = agents.flatMap((owner) => (owner.children ?? []).flatMap((c) => (c ? [{ c, owner }] : [])));
  const claimed = new Set<SubagentRun>();
  const vouched = new Set<SubagentRun>();
  for (const same of [sameId, sameLabel]) {
    for (const { c, owner } of children) {
      if (claimed.has(c)) continue;
      const i = unclaimed.findIndex((run) => mayPair(run, owner, agents) && same(run, c));
      if (i === -1) continue;
      unclaimed.splice(i, 1);
      claimed.add(c);
      if (owner.status !== "ended") vouched.add(c);
    }
  }
  return { vouched, unclaimed };
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
