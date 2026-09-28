// What a chat wants from Jon when its turn ends: the "Your move" line that
// scripts/hooks/report-move.ts saves, and how big a job answering it is.
// cmux keeps only the start of a message, so the line reaches the sidebar
// through the saved state, never through the message itself.

import type { SavedMove } from "../../scripts/state-config.ts";
import { isIdleNudge, savedFor } from "./needs.ts";
import { SAVED_STATE } from "./persist.ts";

// wsId -> the move its chat last ended a turn on, fixed at build. A test can
// seed __STATE__ from before this map existed, so it may be missing at runtime.
function savedMoveFor(wsId: string): SavedMove | undefined {
  const map: Record<string, SavedMove> | undefined = SAVED_STATE.moves;
  return map && Object.hasOwn(map, wsId) ? map[wsId] : undefined;
}

// When the agent last worked, as far as cmux says: the earlier of its last
// activity and the start of its current spell, 0 when neither is known. The
// earlier, because either can move without work: cmux may restart the spell
// when Claude Code's idle nudge lands (unconfirmed, issue #4), and whether
// it stamps activity on that nudge is unconfirmed too (isIdleNudge assumes
// it does not). Real work moves both, so a move older than both is stale.
function lastWorked(a: Agent): number {
  const known = [a.lastActivityAt ?? 0, a.sinceEpoch ?? 0].filter((t) => t > 0);
  return known.length ? Math.min(...known) : 0;
}

/**
 * The move `a` is waiting on, or null. Pass `a` as the sidebars show it
 * (agentsOf) and `asking` from askReason. Only a turn end counts: cmux says
 * needs_input and it is not an ask, and it reads as needs_input still or as
 * idle only because of the idle nudge (a dismissal hides the move with the
 * flag). The move is current while the agent has not worked since it was
 * saved (lastWorked, ASK_SLACK aside, since the hook and cmux's own hook
 * fire on the same Stop): a move from an earlier turn never shows once the
 * chat has worked again, and the nudge about 60s on does not hide it. As
 * with asks, when one of the workspace's agents carries the move's session
 * as its id, only that agent's turn end borrows it.
 */
export function waitingMove(a: Agent | null | undefined, w: Workspace | undefined, asking: boolean): SavedMove | null {
  if (!a || !w || asking) return null;
  const raw = (w.agents ?? []).find((x) => x?.id === a.id) ?? a;
  if (raw.status !== "needs_input" || (a.status !== "needs_input" && !isIdleNudge(raw, w))) return null;
  const since = lastWorked(raw);
  return since ? savedFor(savedMoveFor(w.id), a, w, since) : null;
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
