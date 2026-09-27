// Cockpit colour tokens.

import type { PrHealth } from "../shared/prs.ts";

export const C = {
  ground: "#F4F2EA",
  card: "#FFFFFF",
  hairline: "#E2DFD3",
  cardEdge: "#1414131F",
  text: "#141413",
  secondary: "#5E5D59",
  tertiary: "#73726C",
  clay: "#D97757",
  clayText: "#A34A2A",
  blue: "#3B6FB6",
  blueHalo: "#3B6FB62E",
  clayHalo: "#D9775738",
  green: "#788C5D",
  grey: "#A09E95",
  segTrack: "#E5E2D6",
  needsBg: "#FBECE4",
  needsEdge: "#F0D2C3",
  needsRowEdge: "#A34A2A29",
  hover: "#7f7f7f14",
  // Lanes and selection stay neutral so hue only ever means state: clay is
  // needs you, blue working, green done. Lane markers step down in lightness
  // from Main to Parked instead.
  laneMain: "#3D3D3A",
  laneReview: "#73726C",
  laneBackground: "#A09E95",
  laneParked: "#C9C6BB",
  laneUnsorted: "#C9C6BB",
  select: "#3D3D3A",
  unreadBg: "#5E5D59",
  metaText: "#6B6A64",
  faint: "#8A8880",
  heading: "#3D3D3A",
  dropTarget: "#1414130F",
  needsHover: "#FFFDFB",
  chipText: "#4A4945",
  chipEdge: "#E8E5DA",
} as const;

interface ChipStyle {
  bg: string;
  fg: string;
  edge: string;
}

// A PR chip's colours by status; closed doubles as the neutral branch chip.
export const PR_STYLE: Record<PrStatus, ChipStyle> = {
  open: { bg: "#EAF1E4", fg: "#3F5A2C", edge: "#D6E4CB" },
  merged: { bg: "#EFEAF7", fg: "#5B3E91", edge: "#DED4EF" },
  closed: { bg: C.ground, fg: C.metaText, edge: C.chipEdge },
};

// An open PR's chip when its health has something to say (shared/prs.ts);
// a quiet one keeps PR_STYLE. Ready is a deeper green than plain open.
const HEALTH_STYLE: Record<Exclude<PrHealth, "quiet">, ChipStyle> = {
  failing: { bg: "#F8E4E2", fg: "#9E2F27", edge: "#EDC9C5" },
  running: { bg: "#F6EEDA", fg: "#7A5A12", edge: "#EADFC2" },
  ready: { bg: "#DCEBCF", fg: "#2F4A1C", edge: "#BFD9A9" },
};

/** A PR chip's colours: its health when it has one, else its status. */
export function prChipStyle(health: PrHealth, status: PrStatus | undefined): ChipStyle {
  if (health !== "quiet") return HEALTH_STYLE[health];
  return status ? PR_STYLE[status] : PR_STYLE.closed;
}
