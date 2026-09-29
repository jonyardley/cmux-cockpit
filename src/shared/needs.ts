// "Needs you", corrected the same way in both sidebars. An agent's
// needs_input reads as idle when it is Claude Code's idle nudge (issue #4) or
// when Jon has dismissed it. The sidebars run in separate contexts, so each
// holds its own dismissals, and a reload forgets them (issues #3 and #5).

import type { SavedAsk } from "../../scripts/state-config.ts";
import { sinceOrActivity } from "./activity.ts";
import { persistSet, SAVED_STATE } from "./persist.ts";

/** Seconds between an agent's last activity and a needs_input that is only a nudge. */
export const NUDGE_GAP = 45;

// Claude Code's "Claude is waiting for your input" notification fires about
// 60s after a turn ends, and cmux records it as needs_input. A real ask (a
// permission prompt, a question) begins as the agent works, so it follows
// the agent's last activity closely. A nudge begins well after it, with
// nothing new in between. The workspace's latestAt counts as activity too,
// so if either timestamp moves when the nudge lands, the gap closes and the
// flag shows as before. The cmux source now shows the nudge restamps
// lastActivityAt along with sinceEpoch (v0.64.25, docs/state-loop.md), so on
// 0.64.25 the gap check does not fire (issue #4). The risk the other way: an
// ask after 45s with no activity cmux records would read as idle. Upstream
// docs give kind as claude, codex or the raw source.
export function isIdleNudge(a: Agent, w?: Workspace): boolean {
  if (a.status !== "needs_input" || a.kind !== "claude" || !a.sinceEpoch) return false;
  // A fresh saved ask proves a real one, however long the agent was quiet
  // before it (a long build, say): the nudge itself is never hooked.
  if (freshAsk(a, w)) return false;
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

// --- Asking or your turn (issue #81) -----------------------------------------------------

/**
 * Seconds allowed between a hook's timestamp and cmux's for the same event.
 * A Claude Code hook (an ask, a move) and cmux's own hook fire on one event,
 * so their stamps land within a second or so of each other either way. Small
 * on purpose: an ask from before the agent went back to work must never
 * colour the turn end that follows it, and that takes at least an approval,
 * the tool run and a reply.
 */
export const HOOK_SLACK = 3;

// wsId -> the last ask its agent made, fixed at build. A test can seed
// __STATE__ from before this map existed, so it may be missing at runtime.
function savedAskFor(wsId: string): SavedAsk | undefined {
  const map: Record<string, SavedAsk> | undefined = SAVED_STATE.asking;
  return map && Object.hasOwn(map, wsId) ? map[wsId] : undefined;
}

/**
 * Why the agent is asking ("allow git push?"), or null when its needs_input
 * is only its turn: it finished and waits for the next prompt. Pass the agent
 * as the sidebars show it (agentsOf), so a nudge or a dismissal is never an
 * ask. An ask counts only while the saved one is at least as new as the
 * spell (HOOK_SLACK aside): once the agent works again and stops, that spell
 * starts after the ask and reads as its turn. Without a start time there is
 * no telling, so it reads as its turn.
 */
export function askReason(a: Agent | null | undefined, w: Workspace | undefined): string | null {
  return a ? (freshAsk(a, w)?.reason ?? null) : null;
}

/**
 * Whether a saved ask can be `a`'s. The entry is
 * saved per workspace with the Claude session that made it; when one of the
 * workspace's agents carries that session as its id (unconfirmed whether
 * cmux agent ids are session ids, as for saved subagent runs), only that
 * agent owns it, so another agent's turn end never borrows it. Otherwise it
 * belongs to the workspace as a whole.
 */
function isOwnSaved(saved: { session?: string }, a: Agent, w: Workspace): boolean {
  const { session } = saved;
  const owned = session !== undefined && (w.agents ?? []).some((x) => x?.id === session);
  return !owned || a.id === session;
}

/**
 * A hook's saved entry (an ask, a move) when it explains `a` from `since` on:
 * saved no earlier than `since`, HOOK_SLACK aside, and `a`'s by `owns`. The
 * one place the slack rule lives.
 */
export function savedFor<T extends { epoch: number; session?: string }>(
  saved: T | undefined,
  a: Agent,
  w: Workspace,
  since: number,
  owns: (saved: T, a: Agent, w: Workspace) => boolean,
): T | null {
  return saved && saved.epoch >= since - HOOK_SLACK && owns(saved, a, w) ? saved : null;
}

// The saved ask that explains `a`'s current needs_input spell, if any.
function freshAsk(a: Agent, w: Workspace | undefined): SavedAsk | null {
  if (!w || a.status !== "needs_input" || !a.sinceEpoch) return null;
  return savedFor(savedAskFor(w.id), a, w, a.sinceEpoch, isOwnSaved);
}

/** A workspace's agents with nudges and dismissals applied, in the app's order. */
// An agent cmux sends with no status is left out here, once, rather than at
// each read: it could only draw as no agent yet count as live wherever a
// read asks `status !== "ended"` (issue #7).
export function agentsOf(w: Workspace | undefined): Agent[] {
  if (w) prune(w);
  return (w?.agents ?? []).filter((a) => !!a?.status).map((a) => effectiveAgent(a, w));
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
