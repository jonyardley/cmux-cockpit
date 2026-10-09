// config/lanes.json read into the lane table, by the same rules as the
// native core's Lanes::from_config (native/core/src/lanes.rs), so the two
// sidebars draw the same lanes from the same file. build.ts runs it and
// bakes the result in as __LANES__; lanes.ts turns it into lanes.
//
// The file is a bare array of {id?, name, color?, density?, folded?, faint?,
// leftOff?}, in display order. Unsorted is built in and last. A field left
// out takes the same-id built-in lane's value, else compact, unfolded and
// plain in laneUnsorted's colour. A colour is a lane token's name, never a
// hex, so every lane reads in both themes.
// A field set to null counts as left out, as serde reads it natively. No
// file, or an empty array, is today's four.

import { isRecord } from "../../scripts/state-config.ts";

/** The tokens a lane may take: the lane tokens in theme.ts, by name. */
const LANE_TOKENS = [
  "laneMain",
  "laneReview",
  "laneBackground",
  "laneParked",
  "laneUnsorted",
  "laneViolet",
  "laneTeal",
  "laneRose",
  "laneBrown",
] as const;
export type LaneToken = (typeof LANE_TOKENS)[number];

/** What an unknown colour's error suggests; the same words as the core's lanes.rs. */
const LANE_COLOR_HINT = `use a lane token (${LANE_TOKENS.slice(0, -1).join(", ")} or ${LANE_TOKENS.at(-1)}); a hex is not taken`;

const DENSITIES = ["full", "compact", "row"] as const;
export type Density = (typeof DENSITIES)[number];

/** One lane, every gap filled: what the build bakes in. */
export interface LaneSpec {
  id: string;
  /** The cmux group name it matches. */
  name: string;
  color: LaneToken;
  density: Density;
  /** Starts folded until Jon folds or opens it himself. */
  folded: boolean;
  /** Its heading and merge-ready hint draw faint. */
  faint: boolean;
  /** Its cards say where you left off ("You: <last prompt>"). */
  leftOff: boolean;
}

const PLAIN = { folded: false, faint: false, leftOff: false };

/** Today's four lanes. Parked alone starts folded and draws faint. */
export const BUILT_IN_LANES: readonly LaneSpec[] = [
  { id: "main", name: "Main activity", color: "laneMain", density: "full", ...PLAIN },
  { id: "review", name: "For review", color: "laneReview", density: "compact", ...PLAIN },
  { id: "bg", name: "Background", color: "laneBackground", density: "compact", ...PLAIN, leftOff: true },
  { id: "parked", name: "Parked", color: "laneParked", density: "row", folded: true, faint: true, leftOff: true },
];

/** Unsorted's id: no configured lane may take it, as an id or a name. */
export const UNSORTED_ID = "unsorted";

export type LanesResult = { ok: true; lanes: readonly LaneSpec[] } | { ok: false; error: string };

type Fail = { error: string };

const KEYS: ReadonlySet<string> = new Set(["id", "name", "color", "density", "folded", "faint", "leftOff"]);

// Widened to unknown so includes() takes any string, no cast.
const TOKEN_NAMES: readonly unknown[] = LANE_TOKENS;
const DENSITY_NAMES: readonly unknown[] = DENSITIES;
const isLaneToken = (v: string): v is LaneToken => TOKEN_NAMES.includes(v);
const isDensity = (v: string): v is Density => DENSITY_NAMES.includes(v);

// An optional string field: absent or null, or a string; anything else fails.
function optString(raw: Record<string, unknown>, key: string, label: string): string | undefined | Fail {
  const v = raw[key] ?? undefined;
  if (v === undefined || typeof v === "string") return v;
  return { error: `${label}: ${key} must be a string` };
}

function optBool(raw: Record<string, unknown>, key: string, label: string): boolean | undefined | Fail {
  const v = raw[key] ?? undefined;
  if (v === undefined || typeof v === "boolean") return v;
  return { error: `${label}: ${key} must be true or false` };
}

const failed = (v: unknown): v is Fail => isRecord(v) && typeof v.error === "string";

// The name and id a lane goes by, both trimmed; the id defaults to the name.
function identity(raw: Record<string, unknown>): { name: string; id: string } | Fail {
  if (typeof raw.name !== "string" || raw.name.trim() === "") return { error: "a lane has no name" };
  const name = raw.name.trim();
  const id = optString(raw, "id", `lane "${name}"`);
  if (failed(id)) return id;
  const trimmed = (id ?? name).trim();
  return trimmed === "" ? { error: `lane "${name}" has an empty id` } : { name, id: trimmed };
}

function colorOf(raw: Record<string, unknown>, label: string, base: LaneSpec | undefined): LaneToken | Fail {
  const c = optString(raw, "color", label);
  if (failed(c)) return c;
  if (c === undefined) return base?.color ?? "laneUnsorted";
  return isLaneToken(c) ? c : { error: `${label}: unknown colour "${c}"; ${LANE_COLOR_HINT}` };
}

function densityOf(raw: Record<string, unknown>, label: string, base: LaneSpec | undefined): Density | Fail {
  const d = optString(raw, "density", label);
  if (failed(d)) return d;
  if (d === undefined) return base?.density ?? "compact";
  return isDensity(d) ? d : { error: `${label}: unknown density "${d}"` };
}

// The three flags, each from the file, else the base lane, else off.
function flagsOf(raw: Record<string, unknown>, label: string, base: LaneSpec | undefined) {
  const out = { folded: false, faint: false, leftOff: false };
  for (const key of ["folded", "faint", "leftOff"] as const) {
    const v = optBool(raw, key, label);
    if (failed(v)) return v;
    out[key] = v ?? base?.[key] ?? false;
  }
  return out;
}

/** One lane from the file, its gaps filled from the same-id built-in lane. */
function configured(raw: unknown): LaneSpec | Fail {
  if (!isRecord(raw)) return { error: "each lane must be an object" };
  const who = identity(raw);
  if (failed(who)) return who;
  const label = `lane "${who.name}"`;
  const unknown = Object.keys(raw).find((k) => !KEYS.has(k));
  if (unknown !== undefined) return { error: `${label}: unknown field "${unknown}"` };
  const base = BUILT_IN_LANES.find((l) => l.id === who.id);
  const color = colorOf(raw, label, base);
  if (failed(color)) return color;
  const density = densityOf(raw, label, base);
  if (failed(density)) return density;
  const flags = flagsOf(raw, label, base);
  if (failed(flags)) return flags;
  return { ...who, color, density, ...flags };
}

/**
 * The table lanes.json describes. A lane without a name, a field it does not
 * know, an unknown colour or density, an id or group name used twice, or an
 * id or name "unsorted" in any case fails it whole.
 */
export function resolveLanes(raw: unknown): LanesResult {
  if (!Array.isArray(raw)) return { ok: false, error: "must be a JSON array of lanes" };
  const lanes: LaneSpec[] = [];
  const ids = new Set<string>();
  const names = new Set<string>();
  for (const item of raw) {
    const lane = configured(item);
    if (failed(lane)) return { ok: false, error: lane.error };
    if (lane.id.toLowerCase() === UNSORTED_ID || lane.name.toLowerCase() === UNSORTED_ID)
      return { ok: false, error: `lane "${lane.name}": "${UNSORTED_ID}" is Unsorted's, as an id or a name` };
    if (ids.has(lane.id)) return { ok: false, error: `two lanes have the id "${lane.id}"` };
    if (names.has(lane.name.toLowerCase())) return { ok: false, error: `two lanes are named "${lane.name}"` };
    ids.add(lane.id);
    names.add(lane.name.toLowerCase());
    lanes.push(lane);
  }
  return { ok: true, lanes: lanes.length ? lanes : BUILT_IN_LANES };
}
