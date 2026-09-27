// Agents panel colour tokens and status styling.

import type { CheckState } from "../../scripts/state-config.ts";
import type { PrHealth } from "../shared/prs.ts";

export const T = {
  ground: "#F6F4EC",
  panel: "#FFFFFF",
  panelEdge: "#1414131A",
  rule: "#F0EEE6",
  text: "#141413",
  secondary: "#5E5D59",
  tertiary: "#73726C",
  metaText: "#6B6A64",
  countBg: "#E5E2D6",
  buttonText: "#3D3D3A",
  buttonHover: "#F4F2EA",
  buttonEdge: "#E2DFD3",
  clay: "#D97757",
  clayText: "#A34A2A",
  clayButton: "#B5532F",
  blue: "#3B6FB6",
  blueHalo: "#3B6FB62E",
  clayHalo: "#D9775738",
  grey: "#A09E95",
  red: "#C0453A",
  hover: "#7f7f7f0F",
} as const;

export const STATUS_DOT: Record<AgentStatus, string> = {
  needs_input: T.clay,
  working: T.blue,
  idle: T.grey,
  ended: "#788C5D",
};

// Status in words for the card, board 2's "Working for 12m".
export const STATUS_TEXT: Record<AgentStatus, string> = {
  needs_input: T.clayText,
  working: "#2F5690",
  idle: T.secondary,
  ended: "#4E6A3A",
};

// A CI check's dot on the card: board 1's green pass, red fail, blue running.
export const CHECK_DOT: Record<CheckState, string> = {
  pass: STATUS_DOT.ended,
  fail: T.red,
  pending: T.blue,
};

export interface ChipColors {
  bg: string;
  fg: string;
  edge: string;
}

export function chipColors(status: PrStatus | "port" | undefined): ChipColors {
  if (status === "open") return { bg: "#EAF1E4", fg: "#3F5A2C", edge: "#D6E4CB" };
  if (status === "merged") return { bg: "#EFEAF7", fg: "#5B3E91", edge: "#DED4EF" };
  return { bg: "#F4F2EA", fg: "#4A4945", edge: "#E8E5DA" };
}

// The cockpit's HEALTH_STYLE, so the PR chip reads the same in both sidebars.
const HEALTH_COLORS: Record<Exclude<PrHealth, "quiet">, ChipColors> = {
  failing: { bg: "#F8E4E2", fg: "#9E2F27", edge: "#EDC9C5" },
  running: { bg: "#F6EEDA", fg: "#7A5A12", edge: "#EADFC2" },
  ready: { bg: "#DCEBCF", fg: "#2F4A1C", edge: "#BFD9A9" },
};

/** The PR chip's colours: its health when it has one, else its status. */
export function prChipColors(health: PrHealth, status: PrStatus | undefined): ChipColors {
  return health === "quiet" ? chipColors(status) : HEALTH_COLORS[health];
}
