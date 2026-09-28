// Cockpit colour tokens. The ink, state hues and unread badge come from
// shared/palette.ts, so they read the same in the agents panel.

import { P } from "../shared/palette.ts";

export const C = {
  ...P,
  ground: "#F4F2EA",
  card: "#FFFFFF",
  hairline: "#E2DFD3",
  cardEdge: "#1414131F",
  amberRowEdge: `${P.amberText}29`,
  // The Ready pill's face: the finished green, faint (issue #53).
  readyBg: `${P.green}1F`,
  segTrack: "#E5E2D6",
  needsBg: "#FBECE4",
  needsEdge: "#F0D2C3",
  needsRowEdge: `${P.clayText}29`,
  hover: "#7f7f7f14",
  // Lanes and selection stay neutral so hue only ever means state: clay is
  // needs you (amber when it is asking), blue working, green finished. Lane
  // markers step down in lightness from Main to Unsorted instead, each a
  // clear step from the next.
  laneMain: "#3D3D3A",
  laneReview: "#5E5D59",
  laneBackground: "#8A8880",
  laneParked: "#B0AEA5",
  laneUnsorted: "#C9C6BB",
  select: "#3D3D3A",
  heading: "#3D3D3A",
  // Clearly stronger than hover, so a drop target reads under the pointer.
  dropTarget: "#1414131F",
  // An empty lane's drop zone under the pointer: a solid face and ink edge
  // (opaque, since ring() fills behind the face).
  zoneLit: "#E7E4D9",
  // A lane anchor's header status while that workspace is selected.
  anchorSelected: "#1414131F",
  needsHover: "#FFFDFB",
} as const;
