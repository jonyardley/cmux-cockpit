// The PR chip's palette, one copy for both sidebars so a PR reads the same
// in each. Hue on the chip says what the PR needs: red failing or in
// conflict (the chip's word tells the two apart), blue running
// (the Checks block's pending dot and the working dot are blue too), green
// ready, and only ready (issue #82): a plain open PR with no verdict is
// neutral, so green never claims a PR is ready when it is not. A quiet
// merged PR stays purple, an open draft slate, and anything else neutral.

import type { PrHealth, PrSummary } from "./prs.ts";

export interface ChipColors {
  bg: string;
  fg: string;
  edge: string;
}

/** The quiet chip: a plain open or closed PR, the branch and the ports. */
export const NEUTRAL_CHIP: ChipColors = { bg: "#F4F2EA", fg: "#4A4945", edge: "#E8E5DA" };

const MERGED_CHIP: ChipColors = { bg: "#EFEAF7", fg: "#5B3E91", edge: "#DED4EF" };

const FAILING_CHIP: ChipColors = { bg: "#F8E4E2", fg: "#9E2F27", edge: "#EDC9C5" };

const HEALTH_CHIP: Record<Exclude<PrHealth, "quiet">, ChipColors> = {
  failing: FAILING_CHIP,
  conflicts: FAILING_CHIP,
  running: { bg: "#E6EEF8", fg: "#2F5690", edge: "#CCDBEF" },
  ready: { bg: "#DCEBCF", fg: "#2F4A1C", edge: "#BFD9A9" },
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

/** The colours for a PR as a view shows it (shared/prs.ts); neutral without one. */
export const summaryColors = (pr: PrSummary | undefined): ChipColors =>
  prChipColors(pr?.health ?? "quiet", pr?.status, pr?.draft);
