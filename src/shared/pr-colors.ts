// The PR chip's palette, one copy for both sidebars so a PR reads the same
// in each. A PR's state is plain coloured words with no pill behind them,
// so every state reads on the white card: green ready, red failing or in
// conflict (the words tell the two apart), blue running (the Checks
// block's pending dot and the working dot are blue too), and grey for the
// rest: a draft, a plain open PR, merged and closed. Only ready is green
// (issue #82). The branch, ports, tidy and review chips keep their pills.

import { P } from "./palette.ts";
import type { PrHealth } from "./prs.ts";

export interface ChipColors {
  bg: string;
  fg: string;
  edge: string;
}

/** The quiet chip: the branch and the ports. */
export const NEUTRAL_CHIP: ChipColors = { bg: "#F4F2EA", fg: "#4A4945", edge: "#E8E5DA" };

/** Ready's green, as words on a card. */
export const READY_INK = P.greenDeep;

const HEALTH_INK: Record<Exclude<PrHealth, "quiet">, string> = {
  failing: P.redText,
  conflicts: P.redText,
  running: P.blueText,
  ready: READY_INK,
};

/** A chip with no face and no edge: only its words show (ui.ts chipHover gives it a link's hover). */
const wordChip = (fg: string): ChipColors => ({ bg: "clear", fg, edge: "clear" });

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

/** A PR chip's colours: its ink, with no face and no edge. */
export const prChipColors = (health: PrHealth): ChipColors => wordChip(prInk(health));
