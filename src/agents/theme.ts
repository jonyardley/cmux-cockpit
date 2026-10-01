// Agents panel colour tokens and status styling. The ink, state hues and
// unread badge come from shared/palette.ts, so they read the same in the
// cockpit.

import type { CheckState } from "../../scripts/state-config.ts";
import { P } from "../shared/palette.ts";
import { hoverFace } from "../shared/shade.ts";

export const T = {
  ...P,
  panel: "#FFFFFF",
  panelEdge: "#1414131A",
  rule: "#F0EEE6",
  clayButton: "#B5532F",
  clayButtonHover: "#9E4727",
  /** Text on a clay face: the Open chat button. */
  onClay: "#FFFFFF",
  hover: "#7f7f7f0F",
  /** The faint face behind the agent's latest message on the card. */
  quote: "#1414130A",
} as const;

/** The face behind this chat's own rows in Pull requests and Made here
 * (issue #183): faint ink, since hue only ever means state. hoverBackground
 * replaces it under the pointer, so the hover face is a step on from it. */
export const HERE_FACE = `${P.text}0A`;
export const HERE_HOVER = hoverFace(HERE_FACE, 0);

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
