// The colours both sidebars share (issue #82): ink, the state hues and the
// unread badge. Each sidebar's theme.ts spreads these into its own tokens,
// so a state reads the same on both sides and each hex lives once. Hue only
// ever means state: clay is your turn, amber asking, blue working, green
// finished; the unread badge stays grey so clay keeps one meaning. A faint
// variant is its hue plus an alpha pair (`${P.green}1F`), so it follows
// the hue.

const ink = {
  text: "#141413",
  secondary: "#5E5D59",
} as const;

export const P = {
  ...ink,
  tertiary: "#73726C",
  metaText: "#6B6A64",
  faint: "#8A8880",
  grey: "#A09E95",
  clay: "#D97757",
  clayText: "#A34A2A",
  clayHalo: "#D9775738",
  blue: "#3B6FB6",
  blueHalo: "#3B6FB62E",
  /** A working status in words, a deeper blue than the dot for contrast. */
  blueText: "#2F5690",
  // Asking (issue #81): an agent stopped on a permission or a question.
  amber: "#D9A03F",
  amberText: "#8A5A0B",
  amberHalo: "#D9A03F38",
  /** The finished green: the dot, a passing check. */
  green: "#788C5D",
  /** The finished green in words: "Finished 3m", the Ready pill. */
  greenText: "#5E7A40",
  red: "#C0453A",
  /** The unread badge: grey on both sides, so clay only ever means needs you. */
  badge: ink.secondary,
  // A link inside a card or panel under the pointer (ui.ts linkBox): a
  // chip-strength face and an edge round it.
  linkHover: "#ECEAE3",
  linkEdge: "#14141347",
  onBadge: "#FFFFFF",
} as const;

/** A status in words, one colour per status on both sides: "Working 14m" in deep blue. */
export const STATUS_TEXT: Record<AgentStatus, string> = {
  needs_input: P.clayText,
  working: P.blueText,
  idle: P.metaText,
  ended: P.greenText,
};
