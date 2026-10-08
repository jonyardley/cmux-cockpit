// Lanes are cmux workspace groups matched by NAME, in display order.
// Unsorted is not a group: it holds every workspace outside the others.
// The table comes from config/lanes.json (lane-config.ts), which build.ts
// bakes in as __LANES__; with no file it is today's four.

import { BUILT_IN_LANES, type Density, type LaneSpec, UNSORTED_ID } from "./lane-config.ts";
import { C } from "./theme.ts";

declare const __LANES__: readonly LaneSpec[] | undefined;

/** A lane's id: its own in lanes.json, else its name. Unsorted's is "unsorted". */
export type LaneKey = string;

export interface Lane {
  key: LaneKey;
  name: string;
  color: string;
  density: Density;
  /** Starts folded until Jon folds or opens it himself. */
  folded: boolean;
  /** Its heading and merge-ready hint draw faint. */
  faint: boolean;
  /** Its cards say where you left off ("You: <last prompt>"). */
  leftOff: boolean;
}

export const UNSORTED_KEY: LaneKey = UNSORTED_ID;

const UNSORTED: Lane = {
  key: UNSORTED_KEY,
  name: "Unsorted",
  color: C.laneUnsorted,
  density: "row",
  folded: false,
  faint: false,
  leftOff: false,
};

const lane = ({ id, color, ...rest }: LaneSpec): Lane => ({ key: id, color: C[color], ...rest });

// A bundle built without the define, and the tests unless they seed one, get today's four.
const SPECS: readonly LaneSpec[] = typeof __LANES__ === "undefined" ? BUILT_IN_LANES : __LANES__;

export const LANES: readonly Lane[] = [...SPECS.map(lane), UNSORTED];

/** A drop above every row lands here, and a new project opens here. */
export const FIRST_LANE: LaneKey = LANES[0]?.key ?? UNSORTED_KEY;

/** The lane with this key, Unsorted included; undefined for a key the table does not hold, which an action ignores. */
export const findLane = (k: LaneKey): Lane | undefined => LANES.find((l) => l.key === k);

/** The lane with this key; Unsorted for a key no lane has. For drawing, where a card always needs a lane. */
export const laneByKey = (k: LaneKey): Lane => findLane(k) ?? UNSORTED;
