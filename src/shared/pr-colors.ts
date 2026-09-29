// The PR chip's palette, one copy for both sidebars so a PR reads the same
// in each. A PR's state words are coloured by its health: green ready, red
// failing or in conflict (the words tell the two apart), blue running (the
// Checks block's pending dot and the working dot are blue too), and grey for
// the rest: a draft, a plain open PR, merged and closed. Only ready is green
// (issue #82). Beside its number the state sits in the quiet chip's pill; a
// state chip on its own gets a faint face and edge of its health's hue, so
// every state still reads on the white card. The branch, ports and review
// chips keep the quiet pill.

import { P } from "./palette.ts";
import type { PrHealth } from "./prs.ts";

export interface ChipColors {
  bg: string;
  fg: string;
  edge: string;
}

/** The quiet chip: the branch, the ports, and a PR's number. */
export const NEUTRAL_CHIP: ChipColors = { bg: P.chipFace, fg: P.secondary, edge: P.chipEdge };

/** Ready's green, as words on a card. */
export const READY_INK = P.greenDeep;

const HEALTH_INK: Record<Exclude<PrHealth, "quiet">, string> = {
  failing: P.redText,
  conflicts: P.redText,
  running: P.blueText,
  ready: READY_INK,
};

// A state chip's face and edge for each health with a hue; quiet takes the
// quiet chip's.
const HEALTH_FACE: Record<Exclude<PrHealth, "quiet">, Omit<ChipColors, "fg">> = {
  failing: { bg: P.redChipFace, edge: P.redChipEdge },
  conflicts: { bg: P.redChipFace, edge: P.redChipEdge },
  running: { bg: P.blueChipFace, edge: P.blueChipEdge },
  ready: { bg: P.greenChipFace, edge: P.greenChipEdge },
};

/**
 * A PR's state as words: its health's colour when it has one, else grey,
 * whether draft, open, merged or closed.
 */
export const prInk = (health: PrHealth): string => (health === "quiet" ? P.metaText : HEALTH_INK[health]);

/**
 * The health a PR's words show while its data may be stale and the chip is
 * dimmed: ready drops to grey, so a stale verdict does not shout.
 */
export const shownHealth = (health: PrHealth, dim: boolean): PrHealth => (dim && health === "ready" ? "quiet" : health);

/** A PR state chip's colours: its ink on a faint face of its health's hue, or the quiet chip's. */
export const prChipColors = (health: PrHealth): ChipColors => {
  const face = health === "quiet" ? NEUTRAL_CHIP : HEALTH_FACE[health];
  return { bg: face.bg, fg: prInk(health), edge: face.edge };
};
