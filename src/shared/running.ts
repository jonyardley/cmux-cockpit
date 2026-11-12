// The native core's background verdict (#360): the core decides whether a
// card's chat still runs background work (native/core/src/running.rs) and
// saves what it found in config/state.json's `running` map
// (native/core/src/running_save.rs), which the agents panel reads here
// rather than keep a rule of its own. The panel then says what the card
// says, one paced rebuild behind it.

import type { SavedRunning } from "../../scripts/state-config.ts";
import { SAVED_STATE } from "./persist.ts";

/** The core's saved verdict for `w`'s card, whatever its agent is doing. */
function savedVerdict(w: Workspace): SavedRunning | undefined {
  const map = SAVED_STATE.running;
  return map && Object.hasOwn(map, w.id) ? map[w.id] : undefined;
}

/**
 * What makes `a` read Running, as the card's rule has it: `a` is idle and
 * is the chat the core's verdict for `w` counts work for. Null otherwise,
 * so a working agent still reads Working and another idle agent in the
 * workspace still reads Idle.
 */
export function runningFor(a: Agent | null | undefined, w: Workspace | undefined): SavedRunning | null {
  if (a?.status !== "idle" || !w) return null;
  const v = savedVerdict(w);
  return v?.agent === a.id ? v : null;
}

/** The status `a` draws in: working while it reads Running, as the card
 * draws it (blue dot, halo and words), else its own. */
export const shownStatus = (a: Agent, w: Workspace | undefined): AgentStatus | undefined =>
  runningFor(a, w) ? "working" : a.status;
