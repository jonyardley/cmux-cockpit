// Merged PRs: once a workspace's PR merges, its card dims while nothing in
// it wants Jon. Nothing moves or closes the card by itself, so it stays
// where Jon left it; filing it away is a lane move from the card menu or a
// drag, and removing the worktree stays in Jon's close-out command.

import { isMergedPr } from "../shared/pr-health.ts";
import { prOf } from "../shared/prs.ts";
import { statusOf } from "./status.ts";

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
