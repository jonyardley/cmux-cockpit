// What a chat wants from Jon when its turn ends: the "Your move" line that
// scripts/hooks/report-move.ts saves, and how big a job answering it is.
// cmux keeps only the start of a message, so the line reaches the sidebar
// through the saved state, and the start of the message only tells it which
// reply the line belongs to.

import type { SavedMove } from "../../scripts/state-config.ts";
import { isIdleNudge, isOwnSaved } from "./needs.ts";
import { SAVED_STATE } from "./persist.ts";
import { isReplyOf } from "./reply-head.ts";

// wsId -> the move its chat last ended a turn on, fixed at build. A test can
// seed __STATE__ from before this map existed, so it may be missing at runtime.
function savedMoveFor(wsId: string): SavedMove | undefined {
  const map: Record<string, SavedMove> | undefined = SAVED_STATE.moves;
  return map && Object.hasOwn(map, wsId) ? map[wsId] : undefined;
}

/**
 * The move `a` is waiting on, or null. Pass `a` as the sidebars show it
 * (agentsOf) and `asking` from askReason. Only a turn end counts: cmux says
 * needs_input and it is not an ask, and it reads as needs_input still or as
 * idle only because of the idle nudge (a dismissal hides the move with the
 * flag). The move is current while the workspace's latest message is the
 * reply it came from (isReplyOf on its saved head). Not cmux's timestamps:
 * the nudge about 60s after a turn ends restamps both the spell and the
 * activity, which would make every move stale a minute on. A new turn's
 * reply changes the message, so an old move never shows against it, and a
 * move saved without a head never shows. As with asks, when one of the
 * workspace's agents carries the move's session as its id, only that
 * agent's turn end borrows it.
 */
export function waitingMove(a: Agent | null | undefined, w: Workspace | undefined, asking: boolean): SavedMove | null {
  if (!a || !w || asking) return null;
  const raw = (w.agents ?? []).find((x) => x?.id === a.id) ?? a;
  if (raw.status !== "needs_input" || (a.status !== "needs_input" && !isIdleNudge(raw, w))) return null;
  const saved = savedMoveFor(w.id);
  if (!saved?.head || !isReplyOf(w.latestMessage, saved.head)) return null;
  return isOwnSaved(saved, a, w) ? saved : null;
}

/**
 * How big answering a move is: "decide" when the reply laid out numbered
 * decisions, "review" when Jon reads something first (a link, "read",
 * "review", "look at"), "quick" when it is a word or a paste ("go", "/clear", a `!`
 * command). null when nothing waits on Jon, or the line gives no clue: the card then shows the line
 * with no chip, since a wrong chip is worse than none.
 */
export type MoveSize = "quick" | "decide" | "review";

// A bare "#N" is only a reference ("see #2044"), so it is no clue.
const REVIEW = /https?:\/\/|claude\.ai\/|\b(?:read|review|look at)\b/i;
const QUICK = /\/clear\b|\bgo\b|(?:^|\s)!\s?\w|\bpaste\b|nothing follows|under (?:a|one|two) minutes?/i;
// Nothing to answer, so no size. "Nothing follows" is different: it ends in /clear.
const NOTHING_WAITS = /nothing (?:else )?waits on you/i;

export function moveSize(m: Pick<SavedMove, "text" | "decisions">): MoveSize | null {
  if ((m.decisions ?? 0) > 0) return "decide";
  if (NOTHING_WAITS.test(m.text)) return null;
  if (REVIEW.test(m.text)) return "review";
  if (QUICK.test(m.text)) return "quick";
  return null;
}

/** The size chip's words: "Quick", "Review", "Decide · 2". */
export function moveSizeText(size: MoveSize, decisions = 0): string {
  if (size === "decide") return decisions > 1 ? "Decide · " + decisions : "Decide";
  return size === "quick" ? "Quick" : "Review";
}
