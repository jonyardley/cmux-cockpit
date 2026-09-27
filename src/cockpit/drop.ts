// Drag and drop in the lanes' flat list.
//
// A drop resolves the target lane from the row above the slot, then
// dispatches workspace.reorder and workspace.group.add (or
// workspace.group.remove for Unsorted).

import { FIRST_LANE, type LaneKey, laneByKey } from "./lanes.ts";
import {
  flatEntries,
  groupForLane,
  groups,
  type LaneEntry,
  laneAnchorIds,
  laneOf,
  moveToLane,
  overrideOrder,
  wsById,
} from "./model.ts";
import { drag, setDrag } from "./state.ts";

export interface DropTarget {
  laneKey: LaneKey;
  /** The card that will sit below the dropped one, in the same lane. */
  nextRef: string | null;
  /** The card that will sit above it, in any lane. */
  prevRef: string | null;
}

// The rows the current drag sees, taken on each drag change. The empty
// lanes' zones only exist mid-drag, so if the renderer ends the drag before
// it calls onMove, the move still resolves against the rows it was dropped
// among rather than the folded ones.
let dragRows: { id: string; entries: LaneEntry[] } | null = null;

/** Reorderable's onDragChange. */
export function handleDragChange(d: DragState | null): void {
  setDrag(d);
  if (d) dragRows = { id: d.id, entries: flatEntries() };
}

// The lane of the nearest row above the slot that belongs to one (the
// folded line holds several lanes, so it is skipped).
function laneAbove(entries: LaneEntry[], index: number): LaneKey {
  for (let i = index - 1; i >= 0; i--) {
    const e = entries[i];
    if (e && e.kind !== "fold") return e.lane;
  }
  return FIRST_LANE;
}

// `index` is the dragged row's slot in the flat list with the row removed.
// The lane is whatever the row above the slot belongs to (a header or an
// empty lane's zone counts, so dropping just under one files the card
// there).
export function resolveDrop(key: string, index: number, rows: LaneEntry[] = flatEntries()): DropTarget {
  const entries = rows.filter((e) => e.id !== key);
  const prev = index > 0 ? entries[index - 1] : undefined;
  const laneKey = laneAbove(entries, index);
  const next = entries[index];
  const nextRef = next?.kind === "ws" && next.lane === laneKey ? next.wsId : null;
  const prevRef = prev?.kind === "ws" ? prev.wsId : null;
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
  const rows = dragRows?.id === key ? dragRows.entries : flatEntries();
  dragRows = null;
  setDrag(null);
  const entry = rows.find((e) => e.id === key);
  if (entry?.kind !== "ws") return;
  const w = wsById(entry.wsId);
  if (!w) return;
  const target = resolveDrop(key, index, rows);
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
// workspace rather than a generated placeholder (model.ts's
// isGeneratedAnchor): laneAnchorIds() no longer hides that real anchor, so
// it shows as a normal card here, but it stays undraggable for the same
// reason. The context menu still offers its "Lane:" items, so it is never
// stuck.
export function isForeignAnchor(wsId: string): boolean {
  const lanes = laneAnchorIds();
  return groups().some((g) => g.anchorId === wsId && !lanes.has(wsId));
}

/** The lane the current drag would drop into, for a header's "Drop here" and a lit zone. */
export const dropLane = (): LaneKey | null => {
  const d = drag();
  if (!d?.id) return null;
  return resolveDrop(d.id, d.index).laneKey;
};
