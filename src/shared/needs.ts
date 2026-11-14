// "Needs you", corrected the same way as the native Cockpit does it. An
// agent's needs_input reads as idle when it is Claude Code's idle nudge
// (issue #4) or when Jon has dismissed it. The agents panel holds its own
// dismissals, and a reload forgets them (issues #3 and #5).
//
// A turn end is read from its closing line too, not from the nudge alone,
// as the Cockpit reads it (`waiting_turn` and `Session::effective_agent` in
// native/core/src/needs.rs, #374): an idle or nudged agent whose turn ended
// on a move asking something of Jon (waitingTurn) reads as needs_input from
// the moment the turn ended. So the panel's This workspace card says Your
// turn, not Running, while the chat's background work runs on, and only a
// "Nothing for you" turn or a dismissed wait says Running there.

import type { SavedAsk, SavedMove } from "../../scripts/state-config.ts";
import { sinceOrActivity } from "./activity.ts";
import { asksNothing, quietTurn, waitingMove } from "./move.ts";
import { persistSet, SAVED_STATE } from "./persist.ts";
import { savedFor } from "./saved.ts";

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

// A needs_input that is not Jon's: the idle nudge, or the nudge on a turn
// that ended on "Nothing for you" (quietOf).
const notJons = (a: Agent, w: Workspace | undefined): boolean => isIdleNudge(a, w) || quietOf(a, w) !== null;

// Whether `a` waits on Jon, dismissals aside: a turn that ended on a move
// asking something of him, or a needs_input that is not a nudge.
const waitsOnJon = (a: Agent, w: Workspace | undefined): boolean =>
  waitingTurn(a, w) !== null || (a.status === "needs_input" && !notJons(a, w));

// The workspace's agents that wait on Jon, its real asks among them: a nudge
// or a quiet turn already reads as idle, so there is nothing to dismiss.
const asking = (w: Workspace | undefined): Agent[] => (w?.agents ?? []).filter((a) => waitsOnJon(a, w));

/**
 * The move `a`'s turn ended on when it waits on Jon: `a`'s own, current (no
 * prompt since), not an ask, and asking something of him. A reply with no
 * label counts, as a turn with no closing line still waits on him (#322);
 * only "Nothing for you" does not. Null otherwise. Pass `a` as cmux sends
 * it. The Cockpit's `waiting_turn` (native/core/src/needs.rs).
 */
function waitingTurn(a: Agent, w: Workspace | undefined): SavedMove | null {
  const m = waitingMove(a, w, freshAsk(a, w) !== null);
  return m && !asksNothing(m) ? m : null;
}

// When `a`'s wait on Jon began, which a dismissal is keyed on: the end of
// `turn`, the turn that waits on him, so the nudge landing a minute on keeps
// the dismissal, else the start of its needs_input spell.
const startOf = (turn: SavedMove | null, a: Agent): number => turn?.epoch ?? sinceOrActivity(a);

// startOf, reading the turn.
const waitStart = (a: Agent, w: Workspace | undefined): number => startOf(waitingTurn(a, w), a);

// Whether Jon dismissed `a`'s wait that began at `start`.
function dismissedAt(w: Workspace | undefined, a: Agent, start: number): boolean {
  tick();
  return !!w && dismissed.get(w.id)?.get(a.id) === start;
}

// Whether `a`'s wait is dismissed, with its waiting turn already read.
const isDismissed = (w: Workspace | undefined, a: Agent, turn: SavedMove | null): boolean =>
  (a.status === "needs_input" || turn !== null) && dismissedAt(w, a, startOf(turn, a));

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
  const live = new Map(asking(w).map((a) => [a.id, waitStart(a, w)]));
  for (const [id, start] of byAgent) if (reported.has(id) && live.get(id) !== start) byAgent.delete(id);
  if (!byAgent.size) dismissed.delete(w.id);
}

/**
 * The agent as the sidebars show it: a turn that ended on a move asking
 * something of Jon reads as needs_input from its end, idle or nudged; any
 * other needs_input reads as idle when it is a nudge, dismissed, or a turn
 * that ended on "Nothing for you".
 */
export function effectiveAgent(a: Agent, w?: Workspace): Agent {
  // Ahead of Running too: background work never hides a turn that asks Jon
  // something. A dismissed one reads as it would without it.
  const turn = waitingTurn(a, w);
  if (turn && !dismissedAt(w, a, turn.epoch)) return { ...a, status: "needs_input", sinceEpoch: turn.epoch };
  if (a.status !== "needs_input") return a;
  // A nudge's idle spell began when the turn ended, not when the nudge landed.
  if (isIdleNudge(a, w) && a.lastActivityAt) return { ...a, status: "idle", sinceEpoch: a.lastActivityAt };
  // A turn that ended on "Nothing for you" waits on the agent, not Jon: idle
  // since that turn ended, not since the nudge.
  const quiet = quietOf(a, w);
  if (quiet) return { ...a, status: "idle", sinceEpoch: quiet.epoch };
  return isIdleNudge(a, w) || isDismissed(w, a, turn) ? { ...a, status: "idle" } : a;
}

// --- Asking or your turn (issue #81) -----------------------------------------------------

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

// The move behind `a`'s nudge when that turn ended on "Nothing for you"
// (shared/move.ts), unless a fresh saved ask says it is really asking.
function quietOf(a: Agent, w: Workspace | undefined): SavedMove | null {
  return a.status === "needs_input" && !freshAsk(a, w) ? quietTurn(a, w) : null;
}

// The saved ask that explains `a`'s current needs_input spell, if any. One
// saved before the end of the turn `a` waits on was answered within that
// turn: a turn that waits on Jon reads as needs_input from its end
// (effectiveAgent), so the slack alone would let it through.
function freshAsk(a: Agent, w: Workspace | undefined): SavedAsk | null {
  if (!w || a.status !== "needs_input" || !a.sinceEpoch) return null;
  const ask = savedFor(savedAskFor(w.id), a, w, a.sinceEpoch, isOwnSaved);
  if (!ask) return null;
  const end = waitingMove(a, w, false)?.epoch;
  return end === undefined || ask.epoch >= end ? ask : null;
}

/** A workspace's agents with nudges and dismissals applied, in the app's order. */
// An agent cmux sends with no status is left out here, once, rather than at
// each read: it could only draw as no agent yet count as live wherever a
// read asks `status !== "ended"` (issue #7).
export function agentsOf(w: Workspace | undefined): Agent[] {
  if (w) prune(w);
  return (w?.agents ?? []).filter((a) => !!a?.status).map((a) => effectiveAgent(a, w));
}

/** Dismisses every real ask in the workspace; each comes back when that agent asks again. */
export function dismissNeeds(w: Workspace | undefined): void {
  const list = asking(w);
  if (!w || !list.length) return;
  // A saved key that is no agent here keeps its dismissal, as prune keeps
  // it: the Cockpit's CI and Ostinato waits ("ci", "ostinato"), which this
  // panel does not read, so a dismissal here never brings those back.
  const reported = new Set((w.agents ?? []).filter((a) => !!a).map((a) => a.id));
  const kept = [...(dismissed.get(w.id) ?? [])].filter(([id]) => !reported.has(id));
  const starts = new Map([...kept, ...list.map((a): [string, number] => [a.id, waitStart(a, w)])]);
  dismissed.set(w.id, starts);
  bump();
  // A start of 0 means the agent had no timestamp, so a later ask without one
  // would match it too; that dismissal holds for this session only.
  const dated = [...starts].filter(([, start]) => start > 0);
  persistSet(`dismissed.${w.id}`, dated.length ? Object.fromEntries(dated) : null);
}
