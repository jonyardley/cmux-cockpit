// A quiet agent: still working, but with no activity for a while, and no
// helper of its own chat running for it. The native Cockpit keeps the same
// rule (native/core/src/quiet.rs), so the same agent reads quiet on each
// side: another chat's helpers in the workspace never hold it off, and nor
// does the background record, which is written only when a turn ends.

import { liveRunCount } from "./subagents.ts";
import { ageSince, nowEpoch } from "./time.ts";
import { QUIET_WORD } from "./words.ts";

/**
 * How long a working agent may go without activity before it reads quiet.
 * Long enough for most builds and test runs; a hung command or a stalled
 * agent passes it.
 */
export const QUIET_SECS = 10 * 60;

/**
 * When `a` last showed activity, if it is working, that was at least
 * QUIET_SECS ago, and none of its own chat's helpers is running in `w`
 * (an agent waiting on its helpers is busy, not stalled); else 0.
 */
export function quietSince(a: Agent | null | undefined, w: Workspace | undefined): number {
  if (a?.status !== "working") return 0;
  const last = a.lastActivityAt ?? 0;
  if (!(last > 0 && nowEpoch() - last >= QUIET_SECS)) return 0;
  return liveRunCount(w, a) > 0 ? 0 : last;
}

/** " · quiet 17m" after a quiet agent's status, else "". */
export function quietSuffix(a: Agent | null | undefined, w: Workspace | undefined): string {
  const since = quietSince(a, w);
  return since ? " · " + QUIET_WORD + " " + ageSince(since) : "";
}
