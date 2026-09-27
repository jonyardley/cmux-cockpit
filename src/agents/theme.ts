// Agents panel colour tokens and status styling.

import type { CheckState } from "../../scripts/state-config.ts";
import { type ChipColors, prChipColors } from "../shared/pr-colors.ts";

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
  clay: "#D97757",
  clayText: "#A34A2A",
  clayButton: "#B5532F",
  clayButtonHover: "#9E4727",
  /** Text and figures on a clay face: the Answer button and the unread badge. */
  onClay: "#FFFFFF",
  blue: "#3B6FB6",
  blueHalo: "#3B6FB62E",
  clayHalo: "#D9775738",
  grey: "#A09E95",
  red: "#C0453A",
  hover: "#7f7f7f0F",
  /** The faint face behind the agent's latest message on the card. */
  quote: "#1414130A",
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

/** A quiet chip: a PR by its status (shared/pr-colors.ts), a port neutral. */
export function chipColors(status: PrStatus | "port" | undefined, draft = false): ChipColors {
  return prChipColors("quiet", status === "port" ? undefined : status, draft);
}
