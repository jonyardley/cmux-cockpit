// Lanes that move themselves: when a workspace's PR turns ready to merge
// (the green chip, prs.ts's "ready" health) it moves to For review, and when
// the PR merges it moves to Parked.
//
// Only the change moves a card, never the state itself: each workspace's
// last seen PR state is saved (State.prSeen), so a drag holds until the PR
// changes again. It has to be saved, not just remembered: PR data arrives
// only with a rebuild, and every rebuild reloads the sidebar. The PR poller
// seeds a workspace's first entry with the state its PR had before that
// poll (scripts/state-url.ts), so a render never writes on a first sighting
// and no reload reshuffles the lanes; this module writes only on a change.

import type { PrSeen } from "../../scripts/state-config.ts";
import { persistSet, SAVED_STATE } from "../shared/persist.ts";
import { prSeenOf } from "../shared/pr-health.ts";
import { checksOf, prOf } from "../shared/prs.ts";
import { nowEpoch } from "../shared/time.ts";
import { displayTitle } from "../shared/titles.ts";
import { type LaneKey, laneByKey } from "./lanes.ts";
import { groups, laneAnchorIds, laneOf, moveToLane } from "./model.ts";
import { drag } from "./state.ts";

/** How long the notice naming a move stays up, in seconds. */
export const NOTICE_SECS = 10;

/** The PR state the lanes react to, read as the card's chip reads it. */
const seenNow = (w: Workspace): PrSeen => prSeenOf(prOf(w), checksOf(w));

const RULES: Readonly<Record<PrSeen, { lane: LaneKey; why: string } | null>> = {
  ready: { lane: "review", why: "PR is ready" },
  merged: { lane: "parked", why: "PR merged" },
  other: null,
};

// A test can seed __STATE__ from before this map existed, so it may be
// missing at runtime even though State says it is not.
const savedSeen: Record<string, PrSeen> | undefined = SAVED_STATE.prSeen;
const seen = new Map<string, PrSeen>(Object.entries(savedSeen ?? {}));

let notice: { text: string; at: number } | null = null;

// A workspace anchoring a group cannot leave it (drop.ts pins it), so it never moves.
const isAnchor = (w: Workspace): boolean => groups().some((g) => g.anchorId === w.id);

// Records the new state, then moves the card if the change calls for it.
function react(w: Workspace, now: PrSeen): void {
  seen.set(w.id, now);
  persistSet(`prSeen.${w.id}`, now);
  const rule = RULES[now];
  if (!rule || isAnchor(w) || laneOf(w) === rule.lane) return;
  moveToLane(w, rule.lane);
  const name = displayTitle(w);
  notice = { text: `Moved ${name ? name + " " : ""}to ${laneByKey(rule.lane).name}: ${rule.why}`, at: nowEpoch() };
}

/**
 * Applies the rules to every workspace whose PR state changed since it was
 * last seen. One with no entry yet waits for the poller to seed it. The renderer has no effect hook, so autoMoveNotice runs this on
 * each read, like model.ts's fileAwaitingCards; it is idempotent, since a
 * state is recorded the moment it is seen. It waits while cmux has not sent
 * its groups (a move then would make a second lane group) and while a drag
 * is in flight.
 */
export function applyAutoMoves(): void {
  const ws = data.workspaces();
  if (!ws || !data.groups() || drag()) return;
  // A lane's generated anchor is its group, with no PR: nothing to record.
  const anchors = laneAnchorIds();
  for (const w of ws) {
    const before = seen.get(w.id);
    if (before === undefined || anchors.has(w.id)) continue;
    const now = seenNow(w);
    if (before !== now) react(w, now);
  }
}

/** The notice naming the last automatic move, for NOTICE_SECS; "" otherwise. */
export function autoMoveNotice(): string {
  applyAutoMoves();
  if (!notice) return "";
  const age = nowEpoch() - notice.at;
  return age >= 0 && age < NOTICE_SECS ? notice.text : "";
}
