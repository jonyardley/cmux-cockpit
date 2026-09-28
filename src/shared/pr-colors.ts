// The PR chip's palette, one copy for both sidebars so a PR reads the same
// in each. A filled hue says what the PR needs: red failing or in conflict
// (the chip's word tells the two apart), blue running (the Checks block's
// pending dot and the working dot are blue too), and ready to merge in
// bright leaf green with dark words and a soft glow round it: the loudest
// chip, and the only one that glows.
// Only ready is green (issue #82): a plain open PR with no verdict is
// neutral. A quiet merged PR stays purple, an open draft slate, and
// anything else neutral.

import { P } from "./palette.ts";
import type { PrHealth, PrSummary } from "./prs.ts";

export interface ChipColors {
  bg: string;
  fg: string;
  edge: string;
  /** A glow round the chip; only ready has one. */
  halo?: string;
}

/** The quiet chip: a plain open or closed PR, the branch and the ports. */
export const NEUTRAL_CHIP: ChipColors = { bg: "#F4F2EA", fg: "#4A4945", edge: "#E8E5DA" };

export const MERGED_CHIP: ChipColors = { bg: "#EFEAF7", fg: "#5B3E91", edge: "#DED4EF" };

const FAILING_CHIP: ChipColors = { bg: "#F8E4E2", fg: "#9E2F27", edge: "#EDC9C5" };

/** Ready's green as words on a card, where the chip's bright leaf would be too pale to read. */
export const READY_INK = P.greenDeep;

const READY_CHIP: ChipColors = { bg: P.readyFace, fg: P.readyWords, edge: P.readyEdge, halo: P.readyHalo };

const HEALTH_CHIP: Record<Exclude<PrHealth, "quiet">, ChipColors> = {
  failing: FAILING_CHIP,
  conflicts: FAILING_CHIP,
  running: { bg: "#E6EEF8", fg: "#2F5690", edge: "#CCDBEF" },
  ready: READY_CHIP,
};

const DRAFT_CHIP: ChipColors = { bg: "#ECEFF3", fg: "#4A5566", edge: "#D9DEE6" };

/**
 * A PR chip's colours: its health when it has one, else slate for an open
 * draft, purple for a merged PR, and neutral for the rest, a plain open PR
 * included. Only the saved PR carries draft (renderer.d.ts), so cmux's own
 * PR data never takes the draft colour.
 */
export function prChipColors(health: PrHealth, status: PrStatus | undefined, draft = false): ChipColors {
  if (health !== "quiet") return HEALTH_CHIP[health];
  if (status === "open" && draft) return DRAFT_CHIP;
  return status === "merged" ? MERGED_CHIP : NEUTRAL_CHIP;
}

/**
 * A PR's health as words outside a chip: the chip's own ink, bar ready,
 * which takes READY_INK so it stays green rather than near black.
 */
export const prInk = (health: PrHealth, status: PrStatus | undefined): string =>
  health === "ready" ? READY_INK : prChipColors(health, status).fg;

/**
 * A chip's colours while its data may be stale and the chip is dimmed: the
 * ready chip drops to neutral, glow and all, since a stale verdict should
 * not shout.
 */
export const dimmedColors = (c: ChipColors, dim: boolean): ChipColors => (dim && c === READY_CHIP ? NEUTRAL_CHIP : c);

/** The colours for a PR as a view shows it (shared/prs.ts, or a chip carrying its fields); neutral without one. */
export const summaryColors = (pr: Pick<PrSummary, "health" | "status" | "draft"> | undefined): ChipColors =>
  prChipColors(pr?.health ?? "quiet", pr?.status, pr?.draft);
