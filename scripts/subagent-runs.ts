// Retention policy for saved subagent runs (docs/state-loop.md "Subagent
// runs"): shared by the report-subagent hook, which prunes on every event,
// and pr-poll.ts, which prunes on every state write too (#40), so a done
// row or a crashed run clears even when nothing reports a new subagent
// event. Kept apart from both so the poller never has to import a hook.

import type { State } from "./state-config.ts";

type SubagentMap = State["subagents"];

// A crashed agent never sends SubagentStop, so a still-running, paired run
// is dropped once it is plainly stale rather than kept forever; a settled
// one is dropped once the sidebar has had a good while to show it. A run
// with no agentId yet is a denied or failed Agent call that never starts
// (PreToolUse fires, SubagentStart never does), so it is dropped sooner.
const UNPAIRED_MAX_AGE_S = 10 * 60;
const RUNNING_MAX_AGE_S = 2 * 60 * 60;
const ENDED_MAX_AGE_S = 10 * 60;

/** Drops stale runs across every workspace, and any workspace left with none. */
export function prune(map: SubagentMap, now: number): SubagentMap {
  const out: SubagentMap = {};
  for (const [wsId, runs] of Object.entries(map)) {
    const kept = runs.filter((r) => {
      if (r.endedEpoch !== undefined) return now - r.endedEpoch <= ENDED_MAX_AGE_S;
      if (r.agentId === undefined) return now - r.startedEpoch <= UNPAIRED_MAX_AGE_S;
      return now - r.startedEpoch <= RUNNING_MAX_AGE_S;
    });
    if (kept.length) out[wsId] = kept;
  }
  return out;
}
