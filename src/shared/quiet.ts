// A quiet agent: still working, but with no activity for a while, and no
// helper of its own chat running for it. The native core decides it
// (native/core/src/quiet.rs), since only it can see the runs a chat
// started before a `/clear`, and saves its verdict in config/state.json's
// `quiet` map (native/core/src/quiet_save.rs), which the agents panel
// reads here. With no Cockpit running there is no verdict, so no suffix.

import type { SavedQuiet } from "../../scripts/state-config.ts";
import { SAVED_STATE } from "./persist.ts";
import { ageSince } from "./time.ts";
import { QUIET_WORD } from "./words.ts";

/** The core's saved quiet verdict for `w`'s card. */
function savedVerdict(w: Workspace): SavedQuiet | undefined {
  const map = SAVED_STATE.quiet;
  return map && Object.hasOwn(map, w.id) ? map[w.id] : undefined;
}

/**
 * When `a` last showed activity, if the core's verdict for `w` says it is
 * quiet: the verdict is about `a`, `a` is still working, and it has shown
 * no activity since. Else 0, so a verdict the rebuild has not yet caught
 * up with never shows.
 */
function quietSince(a: Agent | null | undefined, w: Workspace | undefined): number {
  if (!a || !w || a.status !== "working") return 0;
  const saved = savedVerdict(w);
  if (!saved || saved.agent !== a.id) return 0;
  return (a.lastActivityAt ?? 0) > saved.since ? 0 : saved.since;
}

/** " · quiet 17m" after a quiet agent's status, else "". */
export function quietSuffix(a: Agent | null | undefined, w: Workspace | undefined): string {
  const since = quietSince(a, w);
  return since ? " · " + QUIET_WORD + " " + ageSince(since) : "";
}
