// Cockpit colour tokens. The ink, state hues and unread badge come from
// shared/palette.ts, so they read the same in the agents panel.

import { P } from "../shared/palette.ts";

export const C = {
  ...P,
  card: "#FFFFFF",
  hairline: P.chipEdge,
  cardEdge: "#1414131F",
  amberRowEdge: `${P.amberText}29`,
  // The Ready pill's face: the finished green, faint (issue #53).
  readyBg: `${P.green}1F`,
  segTrack: P.countBg,
  needsBg: "#FBECE4",
  needsEdge: "#F0D2C3",
  needsRowEdge: `${P.clayText}29`,
  hover: "#7f7f7f14",
  // A card's face under the pointer. Opaque, since hoverBackground replaces
  // the white face rather than washing over it.
  cardHover: "#F7F6F2",
  // Selection and today's lanes stay neutral so hue means state: clay is
  // needs you (amber when it is asking), blue working, green finished. The
  // built-in lane markers step down in lightness from Main to Unsorted,
  // each a clear step from the next. Violet, teal and rose are for
  // lanes config/lanes.json colours (issue #294), chosen clear of every
  // state hue; the native panel pairs each with a dark value.
  laneMain: "#3D3D3A",
  laneReview: "#5E5D59",
  laneBackground: "#8A8880",
  laneParked: "#B0AEA5",
  laneUnsorted: "#C9C6BB",
  laneViolet: "#7A5BA6",
  laneTeal: "#2E8A86",
  laneRose: "#B04A75",
  select: "#3D3D3A",
  // The inline editor's outline: ink at a third.
  selectEdge: "#14141357",
  // A text field's edge: the field draws none of its own.
  fieldEdge: "#14141333",
  heading: "#3D3D3A",
  // Clearly stronger than hover, so a drop target reads under the pointer.
  dropTarget: "#1414131F",
  // An empty lane's drop zone under the pointer: a solid face and ink edge
  // (opaque, since ring() fills behind the face).
  zoneLit: "#E7E4D9",
  // A lane anchor's header status while that workspace is selected.
  anchorSelected: "#1414131F",
  // A needs-you row under the pointer: a clear step down from its white
  // face, still in the strip's clay family.
  needsHover: "#FBF1EB",
} as const;
