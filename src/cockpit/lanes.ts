// Lanes are cmux workspace groups matched by NAME, in display order.
// Unsorted is not a group: it holds every workspace outside the others.

import { C } from "./theme.ts";

export type LaneKey = "main" | "review" | "bg" | "parked" | "unsorted";

export interface Lane {
  key: LaneKey;
  name: string;
  color: string;
  density: "full" | "compact" | "row";
  startsCollapsed?: boolean;
}

const UNSORTED: Lane = { key: "unsorted", name: "Unsorted", color: C.laneUnsorted, density: "row" };

export const LANES: readonly Lane[] = [
  { key: "main", name: "Main activity", color: "#D97757", density: "full" },
  { key: "review", name: "For review", color: "#4F7CC0", density: "compact" },
  { key: "bg", name: "Background", color: C.laneBackground, density: "compact" },
  { key: "parked", name: "Parked", color: "#B0AEA5", density: "row", startsCollapsed: true },
  UNSORTED,
];

/** A drop above every row lands here. */
export const FIRST_LANE: LaneKey = "main";

export const laneByKey = (k: LaneKey): Lane => LANES.find((l) => l.key === k) ?? UNSORTED;
