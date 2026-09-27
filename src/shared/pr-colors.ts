// The PR chip's palette, one copy for both sidebars so a PR reads the same
// in each. Hue on the chip says what the PR needs: red failing, blue running
// (the Checks block's pending dot and the working dot are blue too), deep
// green ready. A quiet chip keeps its status colour: open green, merged
// purple, closed neutral, except an open draft, which is slate so it reads
// neither ready for review nor dead.

import type { PrHealth } from "./prs.ts";

export interface ChipColors {
  bg: string;
  fg: string;
  edge: string;
}

const STATUS_CHIP: Record<PrStatus, ChipColors> = {
  open: { bg: "#EAF1E4", fg: "#3F5A2C", edge: "#D6E4CB" },
  merged: { bg: "#EFEAF7", fg: "#5B3E91", edge: "#DED4EF" },
  closed: { bg: "#F4F2EA", fg: "#4A4945", edge: "#E8E5DA" },
};

const HEALTH_CHIP: Record<Exclude<PrHealth, "quiet">, ChipColors> = {
  failing: { bg: "#F8E4E2", fg: "#9E2F27", edge: "#EDC9C5" },
  running: { bg: "#E6EEF8", fg: "#2F5690", edge: "#CCDBEF" },
  ready: { bg: "#DCEBCF", fg: "#2F4A1C", edge: "#BFD9A9" },
};

const DRAFT_CHIP: ChipColors = { bg: "#ECEFF3", fg: "#4A5566", edge: "#D9DEE6" };

/**
 * A PR chip's colours: its health when it has one, else slate for an open
 * draft, else its status; neutral with neither. Only the saved PR carries
 * draft (renderer.d.ts), so cmux's own PR data always takes its status colour.
 */
export function prChipColors(health: PrHealth, status: PrStatus | undefined, draft = false): ChipColors {
  if (health !== "quiet") return HEALTH_CHIP[health];
  if (status === "open" && draft) return DRAFT_CHIP;
  return status ? STATUS_CHIP[status] : STATUS_CHIP.closed;
}
