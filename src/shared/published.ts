// Pages and docs agents published (issue #52), from the saved state:
// scripts/hooks/report-published.ts records them in config/state.json
// because cmux knows nothing about them. The "Made here" view (wave 2)
// reads them through here; this module holds no view.

import type { SavedPublished } from "../../scripts/state-config.ts";
import { SAVED_STATE } from "./persist.ts";

/** Every saved page and doc, newest first. */
export function savedPublished(): SavedPublished[] {
  // A test can seed __STATE__ from before this field existed, so the map
  // itself may be missing at runtime even though State says it is not.
  const map: Record<string, SavedPublished> | undefined = SAVED_STATE.published;
  return map ? Object.values(map).sort((a, b) => b.epoch - a.epoch) : [];
}
