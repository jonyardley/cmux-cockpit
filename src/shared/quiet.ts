// A quiet agent: still working, but with no activity for a while, and no
// helper running for it. Both sidebars read it, so the same agent reads
// quiet on each side.

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
 * QUIET_SECS ago, and none of `w`'s helpers is running (an agent waiting
 * on its helpers is busy, not stalled); else 0.
 */
export function quietSince(a: Agent | null | undefined, w: Workspace | undefined): number {
  const last = a?.status === "working" ? (a.lastActivityAt ?? 0) : 0;
  const now = nowEpoch();
  if (!(last > 0 && now - last >= QUIET_SECS)) return 0;
  return liveRunCount(w) > 0 ? 0 : last;
}

/** " · quiet 17m" after a quiet agent's status, else "". */
export function quietSuffix(a: Agent | null | undefined, w: Workspace | undefined): string {
  const since = quietSince(a, w);
  return since ? " · " + QUIET_WORD + " " + ageSince(since) : "";
}
