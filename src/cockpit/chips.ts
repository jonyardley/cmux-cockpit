// Whether a card's chips row has anything to show (issue #79), so a card with
// nothing there drops the row and the gap above it.

import { type Chip, canFileForReview } from "./model.ts";

/**
 * True when the chips row shows a chip from `chips` (a chipsFor list) or the
 * To review action. Taking the list lets the row share one chipsFor per
 * change with its chips.
 */
export function showsChipsRow(chips: readonly Chip[], w: Workspace | undefined): boolean {
  return chips.length > 0 || canFileForReview(w);
}
