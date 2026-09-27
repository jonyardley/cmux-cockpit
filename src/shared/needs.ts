// "Needs you", corrected the same way in both sidebars. An agent's
// needs_input reads as idle when it is Claude Code's idle nudge (issue #4) or
// when Jon has dismissed it. The sidebars run in separate contexts, so each
// holds its own dismissals, and a reload forgets them (issues #3 and #5).

import { sinceOrActivity } from "./activity.ts";
import { persistSet, SAVED_STATE } from "./persist.ts";

/** Seconds between an agent's last activity and a needs_input that is only a nudge. */
export const NUDGE_GAP = 45;

// Claude Code's "Claude is waiting for your input" notification fires about
// 60s after a turn ends, and cmux records it as needs_input (cause not yet
// confirmed, issue #4). A real ask (a permission prompt, a question) begins
// as the agent works, so it follows the agent's last activity closely. A
// nudge begins well after it, with nothing new in between. The workspace's
// latestAt counts as activity too, so if either timestamp moves when the
// nudge lands, the gap closes and the flag shows as before. The risk the
// other way: an ask after 45s with no activity cmux records would read as
// idle. Upstream docs give kind as claude, codex or the raw source.
export function isIdleNudge(a: Agent, w?: Workspace): boolean {
  if (a.status !== "needs_input" || a.kind !== "claude" || !a.sinceEpoch) return false;
  const before = Math.max(a.lastActivityAt ?? 0, w?.latestAt ?? 0);
  return before > 0 && a.sinceEpoch - before >= NUDGE_GAP;
}

// A dismissal is keyed to the workspace, the agent and the start of that
// needs_input spell, so a new ask (a new start) shows again. Plain Maps, so
// reads call tick() and writes call bump(). Seeded from SAVED_STATE so a
// dismissal made before the last reload still holds (issue #5); dismissNeeds
// and restoreNeeds call persistSet so a new one survives the next reload.
// wsId -> agent id -> needs_input start
const dismissed = new Map<string, Map<string, number>>(
  Object.entries(SAVED_STATE.dismissed).map(([wsId, starts]) => [wsId, new Map(Object.entries(starts))]),
);
const [tick, setTick] = signal(0);
const bump = () => setTick(tick() + 1);

// Real asks only: a nudge already reads as idle, so there is nothing to dismiss.
const asking = (w: Workspace | undefined): Agent[] =>
  (w?.agents ?? []).filter((a) => a?.status === "needs_input" && !isIdleNudge(a, w));

function isDismissed(w: Workspace | undefined, a: Agent): boolean {
  tick();
  return !!w && a.status === "needs_input" && dismissed.get(w.id)?.get(a.id) === sinceOrActivity(a);
}

// Drops dismissals whose spell has ended, so a later ask with the same start
// (or none) is not hidden. Only for agents the workspace reports: straight
// after a reload cmux can report a workspace before its agents, and that must
// not wipe a dismissal seeded from disk. Not a write anyone reads reactively:
// what shows is unchanged, so no bump(). Runs during render, so it never
// persists: a stale saved entry is harmless (issue #5), since it can only
// match its exact start, and the file caps entries.
function prune(w: Workspace): void {
  const byAgent = dismissed.get(w.id);
  if (!byAgent) return;
  const reported = new Set((w.agents ?? []).filter((a) => !!a).map((a) => a.id));
  const live = new Map(asking(w).map((a) => [a.id, sinceOrActivity(a)]));
  for (const [id, start] of byAgent) if (reported.has(id) && live.get(id) !== start) byAgent.delete(id);
  if (!byAgent.size) dismissed.delete(w.id);
}

/** The agent as the sidebars show it: needs_input reads as idle when it is a nudge or dismissed. */
export function effectiveAgent(a: Agent, w?: Workspace): Agent {
  if (a.status !== "needs_input") return a;
  // A nudge's idle spell began when the turn ended, not when the nudge landed.
  if (isIdleNudge(a, w) && a.lastActivityAt) return { ...a, status: "idle", sinceEpoch: a.lastActivityAt };
  return isIdleNudge(a, w) || isDismissed(w, a) ? { ...a, status: "idle" } : a;
}

/** A workspace's agents with nudges and dismissals applied, in the app's order. */
export function agentsOf(w: Workspace | undefined): Agent[] {
  if (w) prune(w);
  return (w?.agents ?? []).filter((a) => !!a).map((a) => effectiveAgent(a, w));
}

/** True while any agent in the workspace is really asking, dismissed or not. */
export const hasRealAsk = (w: Workspace | undefined): boolean => asking(w).length > 0;

/** True when dismissals are all that keep the workspace from showing needs you. */
export function isNeedsDismissed(w: Workspace | undefined): boolean {
  const list = asking(w);
  return list.length > 0 && list.every((a) => isDismissed(w, a));
}

/** Dismisses every real ask in the workspace; each comes back when that agent asks again. */
export function dismissNeeds(w: Workspace | undefined): void {
  const list = asking(w);
  if (!w || !list.length) return;
  const starts = new Map(list.map((a) => [a.id, sinceOrActivity(a)]));
  dismissed.set(w.id, starts);
  bump();
  // A start of 0 means the agent had no timestamp, so a later ask without one
  // would match it too; that dismissal holds for this session only.
  const dated = [...starts].filter(([, start]) => start > 0);
  persistSet(`dismissed.${w.id}`, dated.length ? Object.fromEntries(dated) : null);
}

export function restoreNeeds(w: Workspace | undefined): void {
  if (!w || !dismissed.delete(w.id)) return;
  bump();
  persistSet(`dismissed.${w.id}`, null);
}
