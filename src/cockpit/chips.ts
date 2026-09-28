// Whether a card's chips row has anything to show (issue #79), so a card with
// nothing there drops the row and the gap above it.

import { canFileForReview, chipsFor } from "./model.ts";

/**
 * True when the chips row shows a chip or the To review action. `withPr`
 * false is the full card, whose PR sits on a line of its own, so a PR chip
 * alone does not make a row there.
 */
export function showsChipsRow(w: Workspace | undefined, withBranch: boolean, withPr: boolean): boolean {
  return chipsFor(w, withBranch).some((c) => withPr || c.id !== "pr") || canFileForReview(w);
}
