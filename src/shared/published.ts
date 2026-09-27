// Pages and docs agents published (issue #52), from the saved state:
// scripts/hooks/report-published.ts records them in config/state.json
// because cmux knows nothing about them. The agents panel's "Made here"
// section (madeHere in src/agents/model.ts) reads them through here; this
// module holds no view.

import type { SavedPublished } from "../../scripts/state-config.ts";
import { SAVED_STATE } from "./persist.ts";
import { isFresh } from "./published-age.ts";

// Newest first, sorted once: the saved state is fixed at build, and the
// Made here section reads this on every clock tick.
const NEWEST_FIRST: readonly SavedPublished[] = sortedNewestFirst();

function sortedNewestFirst(): SavedPublished[] {
  // A test can seed __STATE__ from before this field existed, so the map
  // itself may be missing at runtime even though State says it is not.
  const map: Record<string, SavedPublished> | undefined = SAVED_STATE.published;
  return map ? Object.values(map).sort((a, b) => b.epoch - a.epoch) : [];
}

/**
 * Every saved page and doc still inside the seven days at `now` (epoch
 * seconds, e.g. nowEpoch()), newest first. The hook prunes only when it
 * writes, so a quiet week would otherwise keep showing old links.
 */
export function savedPublished(now: number): SavedPublished[] {
  return NEWEST_FIRST.filter((e) => isFresh(e.epoch, now));
}
