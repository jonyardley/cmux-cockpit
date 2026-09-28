// The PR chip's palette, one copy for both sidebars so a PR reads the same
// in each. Hue on the chip says what the PR needs: red failing or in
// conflict (the chip's word tells the two apart), blue running
// (the Checks block's pending dot and the working dot are blue too), green
// ready. A plain open PR is GitHub's green as an outline, light fill and
// green words, so it reads as live without claiming the filled ready chip
// (issue #82). A quiet merged PR stays purple, an open draft slate, and
// anything else neutral.

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

const OPEN_CHIP: ChipColors = { bg: "#F3FAF4", fg: "#1A7F37", edge: "#9FD4AD" };

const DRAFT_CHIP: ChipColors = { bg: "#ECEFF3", fg: "#4A5566", edge: "#D9DEE6" };

/**
 * A PR chip's colours: its health when it has one, else slate for an open
 * draft, green outline for a plain open PR, purple for a merged PR, and
 * neutral for the rest. Only the saved PR carries draft (renderer.d.ts), so cmux's own
 * PR data never takes the draft colour.
 */
export function prChipColors(health: PrHealth, status: PrStatus | undefined, draft = false): ChipColors {
  if (health !== "quiet") return HEALTH_CHIP[health];
  if (status === "open") return draft ? DRAFT_CHIP : OPEN_CHIP;
  return status === "merged" ? MERGED_CHIP : NEUTRAL_CHIP;
}

/** The colours for a PR as a view shows it (shared/prs.ts, or a chip carrying its fields); neutral without one. */
export const summaryColors = (pr: Pick<PrSummary, "health" | "status" | "draft"> | undefined): ChipColors =>
  prChipColors(pr?.health ?? "quiet", pr?.status, pr?.draft);
