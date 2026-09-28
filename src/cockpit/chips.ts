// Whether a card's chips row has anything to show (issue #79), so a card with
// nothing there drops the row and the gap above it.

import { type Chip, canFileForReview } from "./model.ts";

/**
 * True when the chips row shows a chip from `chips` (a chipsFor list) or the
 * To review action. `withPr` false is the full card, whose PR sits on a line
 * of its own, so a PR chip alone does not make a row there. Taking the list
 * lets the row share one chipsFor per change with its chips.
 */
export function showsChipsRow(chips: readonly Chip[], w: Workspace | undefined, withPr: boolean): boolean {
  return chips.some((c) => withPr || c.id !== "pr") || canFileForReview(w);
}
