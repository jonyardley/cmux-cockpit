// Drag and drop in the lanes' flat list.
//
// A drop resolves the target lane from the row above the slot, then
// dispatches workspace.reorder and workspace.group.add (or
// workspace.group.remove for Unsorted).

import { flatEntries, type LaneEntry, stateRank } from "./lane-entries.ts";
import { FIRST_LANE, type LaneKey, laneByKey } from "./lanes.ts";
import { groupForLane, groups, laneAnchorIds, laneOf, moveToLane, overrideOrder, wsById } from "./model.ts";
import { drag, mode, setDrag } from "./state.ts";

export interface DropTarget {
  laneKey: LaneKey;
  /** The card that will sit below the dropped one, in the same lane. */
  nextRef: string | null;
  /** The card that will sit above it, in any lane. */
  prevRef: string | null;
}

// `index` is the dragged row's slot in the flat list with the row removed.
// The lane is whatever the row above the slot belongs to (a header or an
// empty lane's zone counts, so dropping just under one files the card
// there). Above every row it is the first lane; an index past the end is
// clamped, so the bottom slot always files into the last row's lane.
function slotOf(key: string, index: number): { entries: LaneEntry[]; at: number; laneKey: LaneKey } {
  const entries = flatEntries().filter((e) => e.id !== key);
  const at = Math.min(Math.max(index, 0), entries.length);
  return { entries, at, laneKey: entries[at - 1]?.lane ?? FIRST_LANE };
}

const isTab = (e: LaneEntry | undefined): e is Extract<LaneEntry, { kind: "ws" | "ghost" }> =>
  e?.kind === "ws" || e?.kind === "ghost";

// The lane's cards in the dragged card's state, as they sit above and below
// the slot.
function peersAround(entries: LaneEntry[], at: number, laneKey: LaneKey, rank: number | null) {
  // A placeholder is its card, waiting, so it is a peer in the waiting rank.
  const peer = (e: LaneEntry | undefined): e is Extract<LaneEntry, { kind: "ws" | "ghost" }> =>
    isTab(e) && e.lane === laneKey && rank !== null && stateRank(wsById(e.wsId)) === rank;
  return { above: entries.slice(0, at).filter(peer).at(-1), below: entries.slice(at).find(peer) };
}

// Cards sort by pin and state inside a lane (lane-entries.ts's stateRank), and the drag
// order only holds among cards in the same pin and state. So a drop anchors to the
// nearest card in the dragged card's own state: just before the first one
// below the slot, else just after the last one above it. Either way it sits
// among its peers where Jon let go. With no peer in the lane it falls back
// to the neighbours: before the card below, else after the card above.
export function resolveDrop(key: string, index: number): DropTarget {
  const { entries, at, laneKey } = slotOf(key, index);
  const dragged = flatEntries().find((e) => e.id === key);
  // Above every row the slot is outside any lane, so it keeps the header rule below.
  const rank = dragged?.kind === "ws" && at > 0 ? stateRank(wsById(dragged.wsId)) : null;
  const { above, below } = peersAround(entries, at, laneKey, rank);
  if (below) return { laneKey, nextRef: below.wsId, prevRef: null };
  if (above) return { laneKey, nextRef: null, prevRef: above.wsId };
  // A placeholder stands for a real tab in its lane, so it anchors a drop as a card does.
  const prev = entries[at - 1];
  const next = entries[at];
  const nextRef = isTab(next) && next.lane === laneKey ? next.wsId : null;
  const prevRef = isTab(prev) ? prev.wsId : null;
  return { laneKey, nextRef, prevRef };
}

// The tab index a dropped workspace should move to among the others, or -1
// to leave its position alone.
function targetIndex(w: Workspace, all: Workspace[], others: string[], drop: DropTarget, changesLane: boolean): number {
  if (drop.nextRef) return others.indexOf(drop.nextRef);
  if (drop.prevRef) {
    const p = others.indexOf(drop.prevRef);
    return p >= 0 ? p + 1 : -1;
  }
  // Dropped straight under a header (an empty lane, say): land after the
  // group's last member, else after its anchor. cmux keeps a group as one
  // contiguous run of tabs, and its lane order differs from ours, so a card
  // left sitting before the anchor falls into the group above it.
  if (!changesLane) return -1;
  const g = groupForLane(laneByKey(drop.laneKey));
  if (!g) return -1;
  const last = all.filter((x) => x.id !== w.id && (x.group === g.id || x.id === g.anchorId)).at(-1)?.id;
  const p = last ? others.indexOf(last) : -1;
  return p >= 0 ? p + 1 : -1;
}

/** Reorderable's onMove: reorders the tab, then files it into its new lane. */
export function handleMove(key: string, index: number): void {
  setDrag(null);
  // The lanes stay mounted, hidden, under Projects: never move from there.
  if (mode() !== "all") return;
  const entry = flatEntries().find((e) => e.id === key);
  if (entry?.kind !== "ws") return;
  const w = wsById(entry.wsId);
  if (!w) return;
  const target = resolveDrop(key, index);
  // Against the lane on screen, so dragging a card back out of a lane it is
  // still waiting to join cancels that move.
  const changesLane = laneOf(w) !== target.laneKey;
  const all = data.workspaces() ?? [];
  const others = all.map((x) => x.id).filter((id) => id !== w.id);
  const at = targetIndex(w, all, others, target, changesLane);

  // Position first, then membership, so the tab is already inside the
  // group's run when it joins.
  if (at >= 0) {
    overrideOrder([...others.slice(0, at), w.id, ...others.slice(at)]);
    cmux("workspace.reorder", { workspace_id: w.id, index: at });
  }
  if (changesLane) moveToLane(w, target.laneKey);
}

// A group's anchor IS that group in cmux, so it cannot leave it: its card is
// pinned in place instead of jumping and snapping back. That covers a
// project group's anchor, and also a lane group anchored on a real
// workspace rather than a generated placeholder (shared/anchors.ts's
// isGeneratedAnchor): laneAnchorIds() no longer hides that real anchor, so
// it shows as a normal card here, but it stays undraggable for the same
// reason. The context menu still offers its "Lane:" items, so it is never
// stuck.
export function isForeignAnchor(wsId: string): boolean {
  const lanes = laneAnchorIds();
  return groups().some((g) => g.anchorId === wsId && !lanes.has(wsId));
}

/** Reorderable's onDragChange: a drag only counts in All, where the lanes show. */
export function handleDragChange(d: DragState | null): void {
  setDrag(mode() === "all" ? d : null);
}

/**
 * The lane the current drag would drop into, for a header's "Drop here" and a
 * lit zone. Computed once per drag move, however many rows read it.
 */
export const dropLane = computed((): LaneKey | null => {
  const d = drag();
  if (!d?.id) return null;
  // The lane alone: the anchor is only worked out on the drop itself.
  return slotOf(d.id, d.index).laneKey;
});
