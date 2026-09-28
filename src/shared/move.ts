// What a chat wants from Jon when its turn ends: the "Your move" line that
// scripts/hooks/report-move.ts saves, and how big a job answering it is.
// cmux keeps only the start of a message, so the line reaches the sidebar
// through the saved state, never through the message itself.

import type { SavedMove } from "../../scripts/state-config.ts";
import { ASK_SLACK } from "./needs.ts";
import { SAVED_STATE } from "./persist.ts";

// wsId -> the move its chat last ended a turn on, fixed at build. A test can
// seed __STATE__ from before this map existed, so it may be missing at runtime.
function savedMoveFor(wsId: string): SavedMove | undefined {
  const map: Record<string, SavedMove> | undefined = SAVED_STATE.moves;
  return map && Object.hasOwn(map, wsId) ? map[wsId] : undefined;
}

/**
 * The move `a` is waiting on, or null. Only a turn end counts: the agent is
 * needs_input and not asking (pass `asking` from askReason), and the move
 * was saved at the start of this needs_input spell (ASK_SLACK aside, since
 * the hook and cmux's own hook fire on the same Stop). A move from an
 * earlier turn is older than the spell, so it never shows once the chat has
 * worked again. As with asks, when one of the workspace's agents carries
 * the move's session as its id, only that agent's turn end borrows it.
 */
export function waitingMove(a: Agent | null | undefined, w: Workspace | undefined, asking: boolean): SavedMove | null {
  if (!a || !w || asking || a.status !== "needs_input" || !a.sinceEpoch) return null;
  const saved = savedMoveFor(w.id);
  if (!saved || saved.epoch < a.sinceEpoch - ASK_SLACK) return null;
  const { session } = saved;
  const owned = session !== undefined && (w.agents ?? []).some((x) => x?.id === session);
  return owned && a.id !== session ? null : saved;
}

/**
 * How big answering a move is: "decide" when the reply laid out numbered
 * decisions, "review" when Jon reads something first (a PR, a link, "read",
 * "review"), "quick" when it is a word or a paste ("go", "/clear", a `!`
 * command). null when the line gives no clue: the card then shows the line
 * with no chip, since a wrong chip is worse than none.
 */
export type MoveSize = "quick" | "decide" | "review";

const REVIEW = /#\d+\b|https?:\/\/|claude\.ai\/|\b(?:read|review|look at|check)\b/i;
const QUICK = /\/clear\b|\bgo\b|(?:^|\s)!\s?\w|\bpaste\b|nothing follows|under (?:a|one|two) minutes?/i;

export function moveSize(m: Pick<SavedMove, "text" | "decisions">): MoveSize | null {
  if ((m.decisions ?? 0) > 0) return "decide";
  if (REVIEW.test(m.text)) return "review";
  if (QUICK.test(m.text)) return "quick";
  return null;
}

/** The size chip's words: "Quick", "Review", "Decide · 2". */
export function moveSizeText(size: MoveSize, decisions = 0): string {
  if (size === "decide") return decisions > 1 ? "Decide · " + decisions : "Decide";
  return size === "quick" ? "Quick" : "Review";
}
