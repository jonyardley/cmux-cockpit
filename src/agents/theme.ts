// Agents panel colour tokens and status styling. The ink, state hues and
// unread badge come from shared/palette.ts, so they read the same in the
// cockpit.

import type { CheckState } from "../../scripts/state-config.ts";
import { P } from "../shared/palette.ts";

export const T = {
  ...P,
  ground: "#F6F4EC",
  panel: "#FFFFFF",
  panelEdge: "#1414131A",
  rule: "#F0EEE6",
  countBg: "#E5E2D6",
  clayButton: "#B5532F",
  clayButtonHover: "#9E4727",
  /** Text on a clay face: the Answer button. */
  onClay: "#FFFFFF",
  hover: "#7f7f7f0F",
  // The PR line on the card under the pointer: a chip-strength face over
  // the white panel, and an edge round it (shared/ui.ts linkBox).
  linkHover: "#EEECE5",
  linkEdge: "#14141347",
  /** The faint face behind the agent's latest message on the card. */
  quote: "#1414130A",
} as const;

/** A stale PR chip's opacity: dimmed while the poller's data is old or gh is down (issue #78). */
export const STALE_OPACITY = 0.5;

export const STATUS_DOT: Record<AgentStatus, string> = {
  needs_input: T.clay,
  working: T.blue,
  idle: T.grey,
  ended: T.green,
};

// A CI check's dot on the card: board 1's green pass, red fail, blue running.
export const CHECK_DOT: Record<CheckState, string> = {
  pass: T.green,
  fail: T.red,
  pending: T.blue,
};
