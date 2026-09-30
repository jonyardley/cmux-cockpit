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
// Jon keeps the sidebar (about 246pt inside the card, 11pt chip text). The
// renderer gives no width to read, so a much narrower or wider sidebar
// makes this a worse guess.
const LINE_CHARS = 36;
// A chip's frame and the gap after it, in characters.
const FRAME_CHARS = 3;
// The glyph before a PR or branch chip's words, with its gap.
const GLYPH_CHARS = 2;
// The branch chip's uncommitted-changes dot, with its gap.
const DIRTY_CHARS = 2;
// "To review →" as it draws, frame included.
const REVIEW_CHARS = 14;

function chipChars(c: Chip): number {
  if (c.id === "pr") {
    const words = c.tag.length + (c.state ? c.state.length + 1 : 0);
    return words + FRAME_CHARS + GLYPH_CHARS + (c.diff ? c.diff.length + 1 : 0);
  }
  // The size and port chips carry no glyph.
  const glyph = c.id === "br" ? GLYPH_CHARS + (c.dirty ? DIRTY_CHARS : 0) : 0;
  return c.text.length + FRAME_CHARS + glyph;
}

/**
 * Whether a card's chips fit on one line, estimated from their text, as the
 * renderer cannot measure.
 */
export function chipsFitOneLine(chips: readonly Chip[], w: Workspace | undefined): boolean {
  let used = canFileForReview(w) ? REVIEW_CHARS : 0;
  for (const c of chips) used += chipChars(c);
  return used <= LINE_CHARS;
}

/**
 * Whether a project card's chips split over two lines: the PR (and size)
 * on the first, the branch, port and To review on the second. Only when
 * both lines have something and they do not fit on one.
 */
export function chipsSplit(chips: readonly Chip[], w: Workspace | undefined): boolean {
  const first = chips.some((c) => c.id === "pr" || c.id === "size");
  const second = chips.some((c) => c.id === "br" || c.id === "port") || canFileForReview(w);
  return first && second && !chipsFitOneLine(chips, w);
}
