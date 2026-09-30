// Whether a card's chips row has anything to show (issue #79), so a card with
// nothing there drops the row and the gap above it.

import { type Chip, canFileForReview, chipsFor } from "./model.ts";

/**
 * True when the chips row shows a chip from `chips` (a chipsFor list) or the
 * To review action. Taking the list lets the row share one chipsFor per
 * change with its chips.
 */
export function showsChipsRow(chips: readonly Chip[], w: Workspace | undefined): boolean {
  return chips.length > 0 || canFileForReview(w);
}

/** showsChipsRow for a card that has no chip list to hand. */
export const hasChipsRow = (w: Workspace | undefined, withBranch: boolean): boolean =>
  showsChipsRow(chipsFor(w, withBranch), w);

// Characters' worth of chips a project card fits on one line at the width
// Jon keeps the sidebar (about 246pt inside the card, 11pt chip text).
const LINE_CHARS = 36;
// A chip's frame, glyph and the gap after it, in characters.
const CHIP_CHARS = 5;
// "To review →" as it draws, frame included.
const REVIEW_CHARS = 14;

/**
 * Whether a card's chips fit on one line, estimated from their text, as the
 * renderer cannot measure. Past LINE_CHARS the branch goes under the PR.
 */
export function chipsFitOneLine(chips: readonly Chip[], w: Workspace | undefined): boolean {
  let used = canFileForReview(w) ? REVIEW_CHARS : 0;
  for (const c of chips) {
    if (c.id === "pr") {
      used += c.tag.length + (c.state ? c.state.length + 1 : 0) + CHIP_CHARS;
      if (c.diff) used += c.diff.length + 1;
    } else used += c.text.length + CHIP_CHARS;
  }
  return used <= LINE_CHARS;
}
