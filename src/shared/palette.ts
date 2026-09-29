// The colours both sidebars share (issue #82): the ground, ink, the state
// hues, the quiet chip and the unread badge. Each sidebar's theme.ts spreads
// these into its own tokens, so a state reads the same on both sides and
// each hex lives once. Hue only ever means state: clay is your turn, amber
// asking, blue working, green finished; the unread badge stays grey so clay
// keeps one meaning. A faint variant is its hue plus an alpha pair
// (`${P.green}1F`), so it follows the hue.

const ink = {
  text: "#141413",
  secondary: "#5E5D59",
} as const;

// The state hues, apart so the faint faces below can be built from them.
const hue = {
  clay: "#D97757",
  blue: "#3B6FB6",
  amber: "#D9A03F",
  /** The finished green: the dot, a passing check. */
  green: "#788C5D",
  /**
   * Ready to merge: the ready chip's words. The same olive as
   * finished, kept well darker so a mergeable PR does not read as a
   * finished agent (test/merge-ready.test.ts holds the gap).
   */
  greenDeep: "#3F5A2B",
  red: "#C0453A",
} as const;

export const P = {
  ...ink,
  ...hue,
  /** Both sidebars' background, so the two read as one surface. */
  ground: "#F4F2EA",
  tertiary: "#73726C",
  metaText: "#6B6A64",
  faint: "#8A8880",
  grey: "#A09E95",
  clayText: "#A34A2A",
  clayHalo: "#D9775738",
  blueHalo: "#3B6FB62E",
  /** A working status in words, a deeper blue than the dot for contrast. */
  blueText: "#2F5690",
  // Asking (issue #81): an agent stopped on a permission or a question.
  amberText: "#8A5A0B",
  amberHalo: "#D9A03F38",
  /** The finished green in words: "Finished 3m", the Ready pill. */
  greenText: "#5E7A40",
  /** A failing or conflicting PR in words, a deeper red than the dot for contrast. */
  redText: "#9E2F27",
  /** The unread badge: grey on both sides, so clay only ever means needs you. */
  badge: ink.secondary,
  // A link inside a card or panel under the pointer (ui.ts linkBox): a
  // chip-strength face and an edge round it.
  linkHover: "#ECEAE3",
  linkEdge: "#14141347",
  onBadge: "#FFFFFF",
  // The quiet chip's face and edge: the branch, the ports, a PR's pill.
  chipFace: "#F1EFE8",
  chipEdge: "#E2DFD3",
  // A PR state's own chip (a state with no number beside it): a faint
  // face of its hue and a stronger edge, so its words sit in a pill.
  blueChipFace: `${hue.blue}1A`,
  blueChipEdge: `${hue.blue}38`,
  greenChipFace: `${hue.green}29`,
  greenChipEdge: `${hue.greenDeep}59`,
  redChipFace: `${hue.red}1A`,
  redChipEdge: `${hue.red}38`,
  /** A count pill with nothing urgent behind it; the segmented control's track too. */
  countBg: "#E5E2D6",
  // A count pill tinted by its most urgent session: clay needs you, amber
  // asking, blue working.
  clayCount: `${hue.clay}29`,
  amberCount: `${hue.amber}29`,
  blueCount: `${hue.blue}1F`,
} as const;

/** A status in words, one colour per status on both sides: "Working 14m" in deep blue. */
export const STATUS_TEXT: Record<AgentStatus, string> = {
  needs_input: P.clayText,
  working: P.blueText,
  idle: P.metaText,
  ended: P.greenText,
};
