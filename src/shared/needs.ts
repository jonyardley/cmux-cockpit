// "Needs you", as the native Cockpit shows it. The core works out each
// agent's status and why it waits on Jon (`Session::agents_of` in
// native/core/src/needs.rs: turns, asks, stops, the CI carrier, parks and
// stand-ins) and saves it in the `agents` map (native/core/src/agents_save.rs,
// #429), so the panel lays that on cmux's agents rather than keep rules of
// its own. The map is baked in at build, so it lags cmux, and with the
// Cockpit closed it is never rewritten: an entry holds only while cmux
// still shows the spell the core saw (`holds`). Otherwise, and for an agent
// with no entry, the agent reads as cmux sends it.
//
// The panel still holds its own dismissals, so one shows at once rather
// than a rebuild later; a reload forgets them unless saved (issues #3 and #5).

import type { SavedAgent, WaitWhy } from "../../scripts/state-config.ts";
import { sinceOrActivity } from "./activity.ts";
import { persistSet, SAVED_STATE } from "./persist.ts";
import { waitOf, waitsFor } from "./waits.ts";

/** The id the core saves a CI or park stand-in under (agents_save.rs STAND_IN). */
export const STAND_IN = "stand-in";

// A dismissal is keyed to the workspace, the agent and the start of that
// wait, so a new ask (a new start) shows again. Plain Maps, so reads call
// tick() and writes call bump(). Seeded from SAVED_STATE so a dismissal made
// before the last reload still holds over a saved entry the core has not yet
// rewritten (issue #5); dismissNeeds calls persistSet so a new one survives
// the next reload.
// wsId -> agent id -> wait start
const dismissed = new Map<string, Map<string, number>>(
  Object.entries(SAVED_STATE.dismissed).map(([wsId, starts]) => [wsId, new Map(Object.entries(starts))]),
);
const [tick, setTick] = signal(0);
const bump = () => setTick(tick() + 1);

// wsId's saved agents. A test can seed __STATE__ from before this map
// existed, so it may be missing at runtime.
function savedAgents(wsId: string): SavedAgent[] {
  const map: Record<string, SavedAgent[]> | undefined = SAVED_STATE.agents;
  return (map && Object.hasOwn(map, wsId) ? map[wsId] : undefined) ?? [];
}

// Seconds between the core's stamp and cmux's for the same event, as the
// core's own HOOK_SLACK (native/core/src/saved.rs).
const HOOK_SLACK = 3;

// A start, 0 when there is none.
const startOf = (t: number | undefined): number => (t !== undefined && t > 0 ? t : 0);

// Whether `e` still speaks for `live`: cmux shows the status the core saw,
// from a start within the slack of the core's, or both have no start. An
// entry saved before the core kept what it saw never holds; the core
// rewrites it on its next frame.
function holds(e: SavedAgent, live: Agent): boolean {
  if (!e.seen || e.seen.status !== live.status) return false;
  const saw = startOf(e.seen.since);
  const now = startOf(live.sinceEpoch);
  return saw && now ? Math.abs(now - saw) <= HOOK_SLACK : !saw && !now;
}

/**
 * The core's saved entry for `live`, an agent as cmux sends it, while it
 * holds. A stop, CI or park whose wait the waits map does not hold yet is
 * no entry, so the agent reads as cmux sends it, a needs_input with a
 * working Dismiss.
 */
function entryOf(live: Agent, w: Workspace): SavedAgent | undefined {
  const e = savedAgents(w.id).find((x) => x.id === live.id);
  if (!e || !holds(e, live)) return undefined;
  return isCockpitWait(e.why) && !waitOf(e.why, live.id, waitsFor(w.id)) ? undefined : e;
}

// Whether `why` is one of the Cockpit's waits (a stop, CI, a park), which
// only the Cockpit dismisses, rather than the agent's own turn or ask.
const isCockpitWait = (why: WaitWhy | undefined): boolean => why === "stop" || why === "ci" || why === "park";

// An agent's own wait Jon can dismiss here: its turn or ask, as the core
// saved it, or cmux's needs_input with no entry.
const ownWait = (live: Agent, e: SavedAgent | undefined): boolean =>
  e ? e.status === "needs_input" && !isCockpitWait(e.why) : live.status === "needs_input";

// When that wait began, as the core keys its dismissal: the end of the turn
// (the saved start, the move's whole-second epoch), else cmux's own start.
const waitStart = (live: Agent, e: SavedAgent | undefined): number =>
  e?.why === "turn" && e.since > 0 ? e.since : sinceOrActivity(live);

// The workspace's agents whose own wait a dismissal can hide.
const asking = (w: Workspace | undefined): Agent[] =>
  w ? (w.agents ?? []).filter((a) => !!a && ownWait(a, entryOf(a, w))) : [];

// Whether Jon dismissed `live`'s own wait.
function isDismissed(w: Workspace, live: Agent, e: SavedAgent | undefined): boolean {
  tick();
  return ownWait(live, e) && dismissed.get(w.id)?.get(live.id) === waitStart(live, e);
}

// Drops dismissals whose wait has ended, so a later ask with the same start
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
  const live = new Map(asking(w).map((a) => [a.id, waitStart(a, entryOf(a, w))]));
  for (const [id, start] of byAgent) if (reported.has(id) && live.get(id) !== start) byAgent.delete(id);
  if (!byAgent.size) dismissed.delete(w.id);
}

// `live` as the panel shows it: the saved status and start laid on, or as
// cmux sends it; a dismissed wait reads as it would without it. A
// Cockpit's wait is left off the status, as before the core saved it: the
// panel names it in the ask block and the Waiting on you card instead.
function shown(live: Agent, w: Workspace): Agent {
  const e = entryOf(live, w);
  if (isDismissed(w, live, e)) return live.status === "needs_input" ? { ...live, status: "idle" } : live;
  if (!e || isCockpitWait(e.why)) return live;
  return e.since > 0 ? { ...live, status: e.status, sinceEpoch: e.since } : { ...live, status: e.status };
}

/** A workspace's agents as the Cockpit shows them, in the app's order. */
// An agent cmux sends with no status is left out here, once, rather than at
// each read: it could only draw as no agent yet count as live wherever a
// read asks `status !== "ended"` (issue #7).
export function agentsOf(w: Workspace | undefined): Agent[] {
  if (!w) return [];
  prune(w);
  return (w.agents ?? []).filter((a) => !!a?.status).map((a) => shown(a, w));
}

/**
 * The saved entry behind `a`, one of `w`'s agents as agentsOf shows it,
 * while it reads needs_input: what it waits on Jon for. None otherwise, so
 * a dismissed or worked-past wait never speaks.
 */
function waitEntry(a: Agent | null | undefined, w: Workspace | undefined): SavedAgent | undefined {
  if (!a || !w || a.status !== "needs_input") return undefined;
  const live = (w.agents ?? []).find((x) => x?.id === a.id);
  const e = live ? entryOf(live, w) : undefined;
  return e?.status === "needs_input" ? e : undefined;
}

/** Why `a` (as agentsOf shows it) waits on Jon, as the core saved it; none
 * without an entry, as with the Cockpit closed. */
export const waitWhy = (a: Agent | null | undefined, w: Workspace | undefined): WaitWhy | undefined =>
  waitEntry(a, w)?.why;

/** When `a`'s turn ended, as the core saved it, while `a` (as agentsOf
 * shows it) waits on its turn; none otherwise. */
export function turnStart(a: Agent | null | undefined, w: Workspace | undefined): number | undefined {
  const e = waitEntry(a, w);
  return e?.why === "turn" ? e.since : undefined;
}

/** The Cockpit's wait (a stop, CI, a park) the core laid on `a`, one of
 * `w`'s agents; none otherwise. */
export function cockpitWait(a: Agent | null | undefined, w: Workspace | undefined): WaitWhy | undefined {
  const live = a && w ? (w.agents ?? []).find((x) => x?.id === a.id) : undefined;
  const e = live && w ? entryOf(live, w) : undefined;
  return e?.status === "needs_input" && isCockpitWait(e.why) ? e.why : undefined;
}

/**
 * Why the agent is asking ("allow git push?"), or null when its needs_input
 * is its turn, a wait the Cockpit saved, or an ask with no words. Pass the
 * agent as agentsOf shows it, so a dismissal is never an ask.
 */
export function askReason(a: Agent | null | undefined, w: Workspace | undefined): string | null {
  const e = waitEntry(a, w);
  return e?.why === "ask" ? (e.reason ?? null) : null;
}

/** Why the core's stand-in waits on Jon in a workspace with no agent left
 * to carry its CI or park; none otherwise. */
export function standInWhy(w: Workspace | undefined): WaitWhy | undefined {
  if (!w || (w.agents ?? []).some((a) => !!a?.status)) return undefined;
  const e = savedAgents(w.id).find((x) => x.id === STAND_IN);
  return e?.status === "needs_input" ? e.why : undefined;
}

// Whether a dismissal on file at `start` is still the one behind agent
// `id`'s saved entry: the entry holds and the start is within the slack of
// the entry's or of what the core saw. A turn is keyed on its move's epoch
// while the core saves the dismissed turn idle at its own start, and an ask
// on cmux's unrounded start while the entry is ceiled to the millisecond.
function stillDismissed(w: Workspace, id: string, start: number): boolean {
  const live = (w.agents ?? []).find((a) => a?.id === id);
  const e = live ? entryOf(live, w) : undefined;
  if (!e) return false;
  const near = (t: number | undefined) => t !== undefined && t > 0 && Math.abs(start - t) <= HOOK_SLACK;
  return near(e.since) || near(e.seen?.since);
}

/** Dismisses every own wait in the workspace; each comes back when that agent asks again. */
export function dismissNeeds(w: Workspace | undefined): void {
  const list = asking(w);
  if (!w || !list.length) return;
  // A saved key that is no agent here keeps its dismissal, as prune keeps
  // it: the Cockpit's CI and Ostinato waits ("ci", "ostinato"), which this
  // panel never dismisses, so a dismissal here never brings those back.
  const reported = new Set((w.agents ?? []).filter((a) => !!a).map((a) => a.id));
  const kept = [...(dismissed.get(w.id) ?? [])].filter(([id]) => !reported.has(id));
  // The core replaces its dismissals with the file's (Session::reseed), and
  // prune drops one here once the core saves that agent idle, so the file's
  // own are written back too, else an earlier dismissal would come back.
  const onFile = Object.entries(
    (Object.hasOwn(SAVED_STATE.dismissed, w.id) && SAVED_STATE.dismissed[w.id]) || {},
  ).filter(([id, start]) => !reported.has(id) || stillDismissed(w, id, start));
  const fresh = list.map((a): [string, number] => [a.id, waitStart(a, entryOf(a, w))]);
  const starts = new Map([...onFile, ...kept, ...fresh]);
  dismissed.set(w.id, starts);
  bump();
  // A start of 0 means the agent had no timestamp, so a later ask without one
  // would match it too; that dismissal holds for this session only.
  const dated = [...starts].filter(([, start]) => start > 0);
  persistSet(`dismissed.${w.id}`, dated.length ? Object.fromEntries(dated) : null);
}
