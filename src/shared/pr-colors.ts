// The PR chip's palette, one copy for both sidebars so a PR reads the same
// in each. Hue on the chip says what the PR needs: red failing, blue running
// (the Checks block's pending dot and the working dot are blue too), deep
// green ready. A quiet chip keeps its status colour: open green, merged
// purple, closed neutral.

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

/** A PR chip's colours: its health when it has one, else its status; neutral with neither. */
export function prChipColors(health: PrHealth, status: PrStatus | undefined): ChipColors {
  if (health !== "quiet") return HEALTH_CHIP[health];
  return status ? STATUS_CHIP[status] : STATUS_CHIP.closed;
}
