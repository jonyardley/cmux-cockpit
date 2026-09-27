// A workspace's subagent runs from the saved state (issue #6): cmux sends
// custom sidebars no subagents, so scripts/hooks/report-subagent.ts records
// them in config/state.json. The agents model reads them through here while
// no agent carries cmux's own `children`, so cmux's data wins the day it
// sends any.

import { SAVED_STATE } from "./persist.ts";

/** A saved run, shaped as renderer.d.ts's SubagentRun, plus its session. */
export interface SavedRun extends SubagentRun {
  /** The Claude Code session that called it, to match an agent by id. */
  session: string;
}

/** The workspace's saved runs, oldest first; none when it has none. */
export function savedRuns(wsId: string): SavedRun[] {
  void wsId;
  void SAVED_STATE;
  return [];
}
