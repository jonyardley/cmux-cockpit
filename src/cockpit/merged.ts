// Merged PRs offer their own tidy-up: once a workspace's PR merges, its card
// dims and offers Park, which files it into Parked; Close workspace, which
// closes it through the socket; and Keep, which stops the offer for that PR
// for good. Nothing moves the card by itself, so it stays where Jon left it
// until he taps. Removing the worktree stays in Jon's close-out command.
//
// Keep is saved (State.mergeKept, the kept PR's number) so it holds past the
// rebuild each PR poll brings, and a later PR in the same workspace offers
// the buttons again. A plain Map, so reads call tick() and writes call bump().

import { persistSet, SAVED_STATE } from "../shared/persist.ts";
import { isMergedPr } from "../shared/pr-health.ts";
import { prOf } from "../shared/prs.ts";
import { isAnchor, laneOf, moveToLane } from "./model.ts";
import { bump, tick } from "./state.ts";
import { statusOf } from "./status.ts";

// A test can seed __STATE__ from before this map existed, so it may be
// missing at runtime even though State says it is not.
const savedKept: Record<string, number> | undefined = SAVED_STATE.mergeKept;
const kept = new Map<string, number>(Object.entries(savedKept ?? {}));

/** The card's PR has merged, by the rule its chip reads. */
export const isMerged = (w: Workspace | undefined): boolean => !!w && isMergedPr(prOf(w));

// An agent still working or asking, or unread output: the card still wants Jon.
const wantsJon = (w: Workspace): boolean => {
  const s = statusOf(w);
  return s === "working" || s === "needs_input" || (w.unread ?? 0) > 0;
};

/** How faint a merged card sits while nothing in it wants Jon. */
export const MERGED_OPACITY = 0.6;

/** Dimmed when merged, but at full strength while lit (selected or dragged) or wanting Jon. */
export function cardOpacity(w: Workspace | undefined, lit: boolean): number {
  return w && isMerged(w) && !lit && !wantsJon(w) ? MERGED_OPACITY : 1;
}

const isKept = (w: Workspace): boolean => {
  tick();
  const at = kept.get(w.id);
  return at !== undefined && at === prOf(w)?.number;
};

/**
 * A merged card offers Keep until Keep is tapped for that PR. Never on a
 * group's anchor (closing it would take the lane) or a pinned workspace
 * (cmux refuses to close one while pinned).
 */
export function offersMergedActions(w: Workspace | undefined): boolean {
  return !!w && isMerged(w) && !isKept(w) && !isAnchor(w) && !w.pinned;
}

/**
 * Close workspace sits beside Keep only while no agent in the workspace is
 * working or asking, so one tap never kills a live agent.
 */
export const offersClose = (w: Workspace | undefined): boolean =>
  !!w && offersMergedActions(w) && statusOf(w) !== "working" && statusOf(w) !== "needs_input";

/** Park sits beside Keep until the card is in Parked. */
export const offersPark = (w: Workspace | undefined): boolean =>
  !!w && offersMergedActions(w) && laneOf(w) !== "parked";

/** Files a merged card into Parked. */
export function parkMerged(w: Workspace | undefined): void {
  if (w && offersPark(w)) moveToLane(w, "parked");
}

/** Hides a merged card's buttons for this PR; the card stays dimmed. */
export function keepMerged(w: Workspace | undefined): void {
  const pr = w && prOf(w)?.number;
  if (!w || !pr || !offersMergedActions(w)) return;
  kept.set(w.id, pr);
  bump();
  persistSet(`mergeKept.${w.id}`, pr);
}

/** Closes a merged card's workspace; the worktree stays for the close-out command. */
export function closeMerged(w: Workspace | undefined): void {
  if (w && offersClose(w)) cmux("workspace.close", { workspace_id: w.id });
}
