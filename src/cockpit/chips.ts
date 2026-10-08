// Whether a card's chips row has anything to show (issue #79), so a card with
// nothing there drops the row and the gap above it.

import { type Chip, chipsFor } from "./card-chips.ts";

/** Whether a card has a chips row: a chip to show, the branch included when asked for. */
export const hasChipsRow = (w: Workspace | undefined, withBranch: boolean): boolean =>
  chipsFor(w, withBranch).length > 0;

// Characters' worth of chips a project card fits on one line at the width
// Jon keeps the sidebar (about 246pt inside the card, 11pt chip text). The
// renderer gives no width to read, so a much narrower or wider sidebar
// makes this a worse guess.
export const PROJECT_LINE_CHARS = 36;
/**
 * The full card's line, narrower by its glyph, set by eye from the preview.
 * It decides every full card's split, and errs towards splitting: a line
 * too many costs height, a line too few cuts the branch.
 */
export const FULL_LINE_CHARS = 32;
// A chip's frame and the gap after it, in characters.
const FRAME_CHARS = 3;
// The glyph before a PR or branch chip's words, with its gap.
const GLYPH_CHARS = 2;
// The branch chip's uncommitted-changes dot, with its gap.
const DIRTY_CHARS = 2;

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
export function chipsFitOneLine(chips: readonly Chip[], lineChars: number): boolean {
  let used = 0;
  for (const c of chips) used += chipChars(c);
  return used <= lineChars;
}

/**
 * Whether a card's chips split over two lines: the PR (and size) on the
 * first; the branch and port on the second. Only when both lines have
 * something and they do not fit on one `lineChars` wide.
 */
export function chipsSplit(chips: readonly Chip[], lineChars: number): boolean {
  const first = chips.some((c) => c.id === "pr" || c.id === "size");
  const second = chips.some((c) => c.id === "br" || c.id === "port");
  return first && second && !chipsFitOneLine(chips, lineChars);
}
