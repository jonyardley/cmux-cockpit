// Whether a card's chips row has anything to show (issue #79), so a card with
// nothing there drops the row and the gap above it.

import { offersClose, offersMergedChip, offersPark } from "./merged.ts";
import { type Chip, canFileForReview, chipsFor } from "./model.ts";

/**
 * True when the chips row shows a chip from `chips` (a chipsFor list), the
 * To review action or a merged card's Park or Close. Taking the list lets the row share one chipsFor per
 * change with its chips.
 */
export function showsChipsRow(chips: readonly Chip[], w: Workspace | undefined): boolean {
  return chips.length > 0 || canFileForReview(w) || offersMergedChip(w);
}

/**
 * The chips a card draws: chipsFor, less a merged card's branch while Park
 * or Close takes its room. A branch with uncommitted changes stays, since
 * its dot is the card's only sign of work left in the worktree.
 */
export function cardChips(w: Workspace | undefined, withBranch: boolean): Chip[] {
  const chips = chipsFor(w, withBranch);
  return offersMergedChip(w) ? chips.filter((c) => c.id !== "br" || c.dirty) : chips;
}

/** showsChipsRow for a card that has no chip list to hand. */
export const hasChipsRow = (w: Workspace | undefined, withBranch: boolean): boolean =>
  showsChipsRow(cardChips(w, withBranch), w);

// Characters' worth of chips a project card fits on one line at the width
// Jon keeps the sidebar (about 246pt inside the card, 11pt chip text). The
// renderer gives no width to read, so a much narrower or wider sidebar
// makes this a worse guess.
export const PROJECT_LINE_CHARS = 36;
/**
 * The full card's line, narrower by its glyph: set from the preview, where
 * "#176 merged", Park and Close fill it with a few points spare. It decides
 * every full card's split, and errs towards splitting: a line too many
 * costs height, a line too few cuts the branch.
 */
export const FULL_LINE_CHARS = 32;
// A chip's frame and the gap after it, in characters.
const FRAME_CHARS = 3;
// The glyph before a PR or branch chip's words, with its gap.
const GLYPH_CHARS = 2;
// The branch chip's uncommitted-changes dot, with its gap.
const DIRTY_CHARS = 2;
// "To review →" as it draws, frame included.
const REVIEW_CHARS = 14;
// A merged card's "Park" and "Close", frames included.
const PARK_CHARS = 7;
const CLOSE_CHARS = 8;

// The action buttons that share the chips line, in characters.
function actionChars(w: Workspace | undefined): number {
  return (
    (canFileForReview(w) ? REVIEW_CHARS : 0) + (offersPark(w) ? PARK_CHARS : 0) + (offersClose(w) ? CLOSE_CHARS : 0)
  );
}

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
export function chipsFitOneLine(chips: readonly Chip[], w: Workspace | undefined, lineChars: number): boolean {
  let used = actionChars(w);
  for (const c of chips) used += chipChars(c);
  return used <= lineChars;
}

/**
 * Whether a card's chips split over two lines: the PR (and size) on the
 * first; the branch, port, To review and a merged card's Park and Close on
 * the second. Only when both lines have something and they do not fit on
 * one `lineChars` wide.
 */
export function chipsSplit(chips: readonly Chip[], w: Workspace | undefined, lineChars: number): boolean {
  const first = chips.some((c) => c.id === "pr" || c.id === "size");
  const second = chips.some((c) => c.id === "br" || c.id === "port") || canFileForReview(w) || offersMergedChip(w);
  return first && second && !chipsFitOneLine(chips, w, lineChars);
}

/**
 * Whether a split's second line fits: the branch, port, To review and a
 * merged card's Park and Close. When it does not, Park and Close take a
 * line of their own under it.
 */
export function secondLineFits(chips: readonly Chip[], w: Workspace | undefined, lineChars: number): boolean {
  let used = actionChars(w);
  for (const c of chips) if (c.id === "br" || c.id === "port") used += chipChars(c);
  return used <= lineChars;
}
