// Agents panel colour tokens and status styling.

import type { CheckState } from "../../scripts/state-config.ts";

export const T = {
  ground: "#F6F4EC",
  panel: "#FFFFFF",
  panelEdge: "#1414131A",
  rule: "#F0EEE6",
  text: "#141413",
  secondary: "#5E5D59",
  tertiary: "#73726C",
  muted: "#6B6A64",
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
  needs_input: "#D97757",
  working: "#3B6FB6",
  idle: "#A09E95",
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
