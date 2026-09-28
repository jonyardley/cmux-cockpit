// Whether what the sidebars show can be trusted (issue #78): PR data the
// poller saved a while ago or could not refresh, and a saved state file that
// could not be read at build. The decisions live here; views only render the
// line and the dim.

import type { PollError, SavedPoll } from "../../scripts/state-config.ts";
import { SAVED_STATE, STATE_UNREADABLE } from "./persist.ts";
import { fmtAge } from "./time.ts";

/** PR data older than this reads as stale: 15 minutes, in seconds. */
export const STALE_AFTER = 15 * 60;

const ERROR_WORDS: Record<PollError, string> = {
  unavailable: "gh unavailable",
  "signed-out": "gh signed out",
  missing: "gh not found",
};

/** What the Pull requests heading says about the saved PR data. */
export interface PrFreshness {
  /** The saved chips are old or could not be refreshed, so they dim. */
  stale: boolean;
  /** The faint line under the heading, "gh unavailable · last checked 2h ago"; "" when fresh. */
  line: string;
}

const FRESH: PrFreshness = { stale: false, line: "" };

// "last checked 2h ago" from the last success; "" without one or a clock.
function lastChecked(okEpoch: number | undefined, now: number): string {
  if (okEpoch === undefined || !now) return "";
  const age = fmtAge(Math.max(0, now - okEpoch));
  return age === "<1m" ? "last checked just now" : "last checked " + age + " ago";
}

/**
 * The saved poll status read against the clock. A current error is always
 * stale and says what went wrong; a last success more than STALE_AFTER ago
 * says how old it is. With nothing saved (the poller has not run since this
 * field existed) or no clock yet it claims nothing, rather than guess.
 */
export function freshnessOf(poll: SavedPoll | undefined, now: number): PrFreshness {
  if (!poll) return FRESH;
  const checked = lastChecked(poll.okEpoch, now);
  if (poll.error) return { stale: true, line: [ERROR_WORDS[poll.error], checked].filter(Boolean).join(" · ") };
  if (poll.okEpoch === undefined || !now || now - poll.okEpoch <= STALE_AFTER) return FRESH;
  const line = checked.charAt(0).toUpperCase() + checked.slice(1);
  return { stale: true, line };
}

/**
 * The saved PR data's freshness at `now`. A state saved before the poll
 * field existed has none, so it is read as nothing saved.
 */
export const prFreshness = (now: number): PrFreshness => freshnessOf(SAVED_STATE.poll, now);

/** The line a sidebar shows in place of looking empty when the saved state could not be read; "" otherwise. */
export function stateNoticeFor(unreadable: boolean): string {
  return unreadable ? "Saved state could not be read: dismissals, projects and PRs are missing" : "";
}

/** stateNoticeFor this build's state file. */
export const stateNotice = (): string => stateNoticeFor(STATE_UNREADABLE);
