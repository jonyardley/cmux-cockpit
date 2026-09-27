// Cockpit colour tokens.

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
  laneBackground: "#788C5D",
  laneUnsorted: "#B0AEA5",
  metaText: "#6B6A64",
  faint: "#8A8880",
  heading: "#3D3D3A",
  dropTarget: "#D977571F",
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
