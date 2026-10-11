// All mode's rows: lane headers, cards in state order, and what each header says.

import { READY_INK } from "../shared/pr-colors.ts";
import { prHealth } from "../shared/prs.ts";
import { LANES, type Lane, type LaneKey, laneByKey } from "./lanes.ts";
import { actualLaneOf, cards, generatedAnchorId, isCollapsed, laneOf, wsById } from "./model.ts";
import { isSelected } from "./state.ts";
import { agentOf, isReady, isWaiting, statusOf } from "./status.ts";
import { heldAtTop, inStrip, releaseHold } from "./strip.ts";
import { C } from "./theme.ts";

// --- All mode: one flat list of lane headers and cards --------------------------------

// A header's key carries the anchor it shows (issue #49), and an empty lane
// is a zone (issue #50), since a row's kind is fixed by its key. A card's key
// is "w:" and its session, without its lane, so a lane move keeps its row
// (cards.ts's cardFor). A session in the Needs you strip leaves a
// placeholder, keyed "g:" and its session.
export type LaneEntry =
  | { kind: "header"; id: string; lane: LaneKey; anchorId: string | null }
  | { kind: "zone"; id: string; lane: LaneKey }
  | { kind: "ws"; id: string; wsId: string; lane: LaneKey }
  | { kind: "ghost"; id: string; wsId: string; lane: LaneKey };

/** A lane's generated anchor when it has an agent or unread messages, so its header shows them. */
function headerAnchorId(lane: Lane): string | null {
  const id = generatedAnchorId(lane);
  const w = id ? wsById(id) : undefined;
  return w && ((w.agents ?? []).length > 0 || (w.unread ?? 0) > 0) ? w.id : null;
}

interface LaneSection {
  lane: Lane;
  rows: Workspace[];
  anchorId: string | null;
}

// Nothing to show: no cards, and no anchor status on the header.
const isEmpty = (s: LaneSection): boolean => s.rows.length === 0 && !s.anchorId;

function liveRank(w: Workspace | undefined): number {
  const s = statusOf(w);
  if (s === "needs_input") {
    if (w) releaseHold(w);
    return 0;
  }
  if (w && heldAtTop(w)) return 0;
  if (isReady(w)) return 1;
  // A Waiting card is drawn in working blue, so it sorts with the working.
  return s === "working" || isWaiting(agentOf(w), w) ? 2 : 3;
}

// The rank each card last had while not selected. Opening a Ready card
// clears its Ready state (status.ts), and answering a card moves it on, so
// the selected card keeps the best of that rank and its live one: it never
// slides out from under the pointer, and it settles once Jon moves on.
// Written during render and read only for the selected card, so no bump().
const heldRank = new Map<string, number>();

// Needs you stays first; a pinned card goes above every unpinned one.
const pinTier = (state: number, pinned: boolean): number => (state === 0 || pinned ? state : state + 3);

/**
 * A card's place in its lane (issue #74): needs you, then the pinned cards,
 * then the rest, each part in state order (Ready, working, the rest). So 0,
 * then 1 to 3 pinned, then 4 to 6. The hold covers the state only; the pin
 * is read live, so unpinning the selected card moves it at once.
 */
export function stateRank(w: Workspace | undefined): number {
  const live = liveRank(w);
  if (!w) return pinTier(live, false);
  let state = live;
  if (!isSelected(w)) heldRank.set(w.id, live);
  else state = Math.min(live, heldRank.get(w.id) ?? live);
  return pinTier(state, !!w.pinned);
}

// Array sort is stable, so cards in the same state keep the tab order Jon
// dragged them into; drop.ts anchors a drop to a card in the same state so it
// lands where he let go.
function byState(rows: Workspace[]): Workspace[] {
  const rank = new Map(rows.map((w) => [w.id, stateRank(w)]));
  return rows.sort((a, b) => (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0));
}

const laneSections = computed((): LaneSection[] => {
  const all = cards();
  return LANES.map((lane) => ({
    lane,
    rows: byState(all.filter((w) => laneOf(w) === lane.key)),
    anchorId: headerAnchorId(lane),
  }));
});

function sectionEntries(s: LaneSection): LaneEntry[] {
  const key = s.lane.key;
  const header: LaneEntry = {
    kind: "header",
    id: s.anchorId ? `h:${key}:${s.anchorId}` : `h:${key}`,
    lane: key,
    anchorId: s.anchorId,
  };
  if (isCollapsed(s.lane)) return [header];
  const waiting = inStrip();
  return [
    header,
    ...s.rows.map(
      (w): LaneEntry =>
        waiting.has(w.id)
          ? { kind: "ghost", id: "g:" + w.id, wsId: w.id, lane: key }
          : { kind: "ws", id: "w:" + w.id, wsId: w.id, lane: key },
    ),
  ];
}

// An empty lane is a zone row in its own place, at rest and mid-drag alike,
// so the renderer's drop index always counts the same rows resolveDrop does.
const laneEntries = computed(() =>
  laneSections().flatMap((s): LaneEntry[] =>
    isEmpty(s) ? [{ kind: "zone", id: "z:" + s.lane.key, lane: s.lane.key }] : sectionEntries(s),
  ),
);

// Built in both modes: the lanes panel stays mounted under Projects, hidden
// (panelOpacity). drop.ts ignores a drag or move outside All instead.
export const flatEntries: () => LaneEntry[] = laneEntries;

/**
 * Whether the card shows your last prompt: in a lane you come back to after a
 * while (`leftOff`, Background and Parked by default), by cmux's own data as
 * cardDensity is.
 */
export const showsLeftOff = (w: Workspace | undefined): boolean => laneByKey(actualLaneOf(w)).leftOff;

/**
 * The cards a lane header counts, every card it lists, folded or not, and
 * the placeholders of those waiting in the Needs you strip. The header
 * filters once per change and reads its count, its pill's tint (status.ts
 * countColors) and, folded, its status dot from the one list.
 */
export const laneWorkspaces = (laneKey: LaneKey): Workspace[] => cards().filter((w) => laneOf(w) === laneKey);

/**
 * A lane header's merge line: "2 ready to merge" when that many of its
 * workspaces hold a PR GitHub would merge now (prs.ts's ready health), else
 * "". Every card the lane counts (laneWorkspaces), placeholders too, since
 * a waiting session's PR is still mergeable. The lane's generated
 * anchor counts as well: it has no card, and its status already sits on the
 * header.
 */
export function mergeReadyText(laneKey: LaneKey): string {
  const anchor = generatedAnchorId(laneByKey(laneKey));
  const ws = [...laneWorkspaces(laneKey), ...(anchor ? [wsById(anchor)] : [])];
  const n = ws.filter((w) => prHealth(w) === "ready").length;
  return n ? n + " ready to merge" : "";
}

/** The words at a lane header's trailing edge, and their ink. */
export interface HeaderHint {
  text: string;
  color: string;
}

/**
 * "Drop here" while a drag is over the lane, else its merge line. A faint
 * lane (Parked by default) keeps its merge line faint, as it does its title: set-aside work should
 * not call out in green. Otherwise Ready's green (pr-colors.ts), so the
 * count reads as the PR verdict, not the agent's Ready pill.
 */
export function headerHint(laneKey: LaneKey, dropping: boolean): HeaderHint {
  if (dropping) return { text: "Drop here", color: C.heading };
  return { text: mergeReadyText(laneKey), color: laneByKey(laneKey).faint ? C.faint : READY_INK };
}
