// The PR chip's palette, one copy for both sidebars so a PR reads the same
// in each. A PR's state words take its tone (prTone): a health with a hue
// wins, red failing or in conflict (the words tell the two apart), blue
// running (the Checks block's pending dot and the working dot are blue too)
// and ready's own green ink; a quiet PR then reads by its state, as GitHub
// colours it: grey draft and closed, green open, purple merged. Open's green
// is a status colour on the chip's words, a cooler green kept apart from
// ready's ink, the finished olive and the merge green, so ready to merge
// still has a green of its own (issue #82). Beside its number the state sits
// in the quiet chip's pill; a state chip on its own gets a faint face and
// edge of its tone's hue, so every state still reads on the white card. The
// branch, ports and review chips keep the quiet pill.

import { P } from "./palette.ts";
import type { PrHealth } from "./prs.ts";

export interface ChipColors {
  bg: string;
  fg: string;
  edge: string;
}

/**
 * What colours a PR's words: its health when that has a hue, else its state.
 * "draft" is an open draft; "quiet" is grey with nothing to say, a PR with
 * no status or a stale ready (shownTone).
 */
export type PrTone = Exclude<PrHealth, "quiet"> | "draft" | "open" | "merged" | "closed" | "quiet";

/** The quiet chip: the branch, the ports, and a PR's number. */
export const NEUTRAL_CHIP: ChipColors = { bg: P.chipFace, fg: P.secondary, edge: P.chipEdge };

/** Ready's green, as words on a card. */
export const READY_INK = P.greenDeep;

/** Grey words for a PR with nothing to say: a draft's, a closed PR's, a stale pass. */
export const QUIET_INK = P.metaText;

const TONE_INK: Record<PrTone, string> = {
  failing: P.redText,
  conflicts: P.redText,
  running: P.blueText,
  ready: READY_INK,
  draft: QUIET_INK,
  open: P.openText,
  merged: P.mergedText,
  closed: QUIET_INK,
  quiet: QUIET_INK,
};

// A state chip's face and edge for each tone, a faint face of its hue; the
// grey ones take the quiet chip's.
const TONE_FACE: Record<PrTone, Omit<ChipColors, "fg">> = {
  failing: { bg: P.redChipFace, edge: P.redChipEdge },
  conflicts: { bg: P.redChipFace, edge: P.redChipEdge },
  running: { bg: P.blueChipFace, edge: P.blueChipEdge },
  ready: { bg: P.greenChipFace, edge: P.greenChipEdge },
  draft: NEUTRAL_CHIP,
  open: { bg: P.openChipFace, edge: P.openChipEdge },
  merged: { bg: P.mergedChipFace, edge: P.mergedChipEdge },
  closed: NEUTRAL_CHIP,
  quiet: NEUTRAL_CHIP,
};

/**
 * A PR's tone: a health with a hue wins (a failing draft is red); a quiet
 * PR reads by its state, a merged or closed one by its status whatever its
 * draft flag, and one with no status stays grey rather than claim open.
 */
export function prTone(status: PrStatus | undefined, draft: boolean | undefined, health: PrHealth): PrTone {
  if (health !== "quiet") return health;
  if (status === "merged" || status === "closed") return status;
  if (status !== "open") return "quiet";
  return draft ? "draft" : "open";
}

/** A PR's state as words: its tone's colour. */
export const prInk = (tone: PrTone): string => TONE_INK[tone];

/**
 * The tone a PR's words show while its data may be stale and the chip is
 * dimmed: ready drops to grey, so a stale verdict (still saying "ready")
 * does not shout, nor borrow open's green; the rest keep their hue, dimmed.
 */
export const shownTone = (tone: PrTone, dim: boolean): PrTone => (dim && tone === "ready" ? "quiet" : tone);

/** A PR state chip's colours: its ink on a faint face of its tone's hue, or the quiet chip's. */
export const prChipColors = (tone: PrTone): ChipColors => {
  const face = TONE_FACE[tone];
  return { bg: face.bg, fg: prInk(tone), edge: face.edge };
};
