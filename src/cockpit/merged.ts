// Merged PRs tidy themselves up: once a workspace's PR merges (the move to
// Parked is automove.ts's), its card dims and offers Close workspace, which
// closes it through the socket, and Keep, which stops the offer for that
// workspace for good. Removing the worktree stays in Jon's close-out command.
//
// Keep is saved (State.mergeKept) so it holds past the rebuild each PR poll
// brings. A plain Map, so reads call tick() and writes call bump().

import { persistSet, SAVED_STATE } from "../shared/persist.ts";
import { prSeenOf } from "../shared/pr-health.ts";
import { checksOf, prOf } from "../shared/prs.ts";
import { nowEpoch } from "../shared/time.ts";
import { groups } from "./model.ts";
import { bump, isSelected, tick } from "./state.ts";

// A test can seed __STATE__ from before this map existed, so it may be
// missing at runtime even though State says it is not.
const savedKept: Record<string, number> | undefined = SAVED_STATE.mergeKept;
const kept = new Map<string, number>(Object.entries(savedKept ?? {}));

/** The card's PR has merged, read as its chip reads it. */
export const isMerged = (w: Workspace | undefined): boolean => !!w && prSeenOf(prOf(w), checksOf(w)) === "merged";

/** How faint a merged card sits: dimmed, but read at full strength once selected. */
export const MERGED_OPACITY = 0.6;

export function cardOpacity(w: Workspace | undefined): number {
  return isMerged(w) && !isSelected(w) ? MERGED_OPACITY : 1;
}

/**
 * A merged card offers Close workspace and Keep until Keep is tapped. A
 * workspace anchoring a group never does: closing it would take its lane's
 * anchor with it.
 */
export function offersMergedActions(w: Workspace | undefined): boolean {
  tick();
  return !!w && isMerged(w) && !kept.has(w.id) && !groups().some((g) => g.anchorId === w.id);
}

/** Hides a merged card's buttons for good; the card stays dimmed. */
export function keepMerged(w: Workspace | undefined): void {
  if (!w || kept.has(w.id)) return;
  const at = nowEpoch();
  kept.set(w.id, at);
  bump();
  persistSet(`mergeKept.${w.id}`, at);
}

/** Closes a merged card's workspace; the worktree stays for the close-out command. */
export function closeMerged(w: Workspace | undefined): void {
  if (w && offersMergedActions(w)) cmux("workspace.close", { workspace_id: w.id });
}
