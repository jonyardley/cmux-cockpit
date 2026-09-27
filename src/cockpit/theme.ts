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
  // Lanes and selection stay neutral so hue only ever means state: clay is
  // needs you, blue working, green done. Lane markers step down in lightness
  // from Main to Unsorted instead, each a clear step from the next.
  laneMain: "#3D3D3A",
  laneReview: "#5E5D59",
  laneBackground: "#8A8880",
  laneParked: "#B0AEA5",
  laneUnsorted: "#C9C6BB",
  select: "#3D3D3A",
  unreadBg: "#5E5D59",
  metaText: "#6B6A64",
  faint: "#8A8880",
  heading: "#3D3D3A",
  // Clearly stronger than hover, so a drop target reads under the pointer.
  dropTarget: "#1414131F",
  // An empty lane's drop zone mid-drag: a quiet edge, then solid face and
  // ink edge under the pointer (opaque, since ring() fills behind the face).
  zoneEdge: "#D3CFC1",
  zoneLit: "#E7E4D9",
  needsHover: "#FFFDFB",
  chipText: "#4A4945",
  chipEdge: "#E8E5DA",
} as const;
