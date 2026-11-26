// config/lanes.json's lane names for __LANES__; native/core/src/lanes.rs checks the other fields

import { isRecord } from "./state-config.ts";

/** Today's four lanes' names, for no file or an empty array. */
export const BUILT_IN_LANE_NAMES: readonly string[] = ["Main activity", "For review", "Background", "Parked"];

const UNSORTED = "unsorted";

export type LaneNamesResult = { ok: true; names: readonly string[] } | { ok: false; error: string };

/**
 * The lane names lanes.json lists, trimmed and in order. A lane that is not
 * an object or has no name, a name used twice in any case, or the name
 * "unsorted" fails it whole.
 */
export function laneNames(raw: unknown): LaneNamesResult {
  if (!Array.isArray(raw)) return { ok: false, error: "must be a JSON array of lanes" };
  const names: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!isRecord(item)) return { ok: false, error: "each lane must be an object" };
    if (typeof item.name !== "string" || item.name.trim() === "") return { ok: false, error: "a lane has no name" };
    const name = item.name.trim();
    const key = name.toLowerCase();
    if (key === UNSORTED) return { ok: false, error: `lane "${name}": "${UNSORTED}" is Unsorted's name` };
    if (seen.has(key)) return { ok: false, error: `two lanes are named "${name}"` };
    seen.add(key);
    names.push(name);
  }
  return { ok: true, names: names.length ? names : BUILT_IN_LANE_NAMES };
}
