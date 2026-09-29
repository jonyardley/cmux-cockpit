// What a chat wants from Jon when its turn ends: the "Your move" line that
// scripts/hooks/report-move.ts saves, and how big a job answering it is.
// cmux keeps only the start of a message, so the line reaches the sidebar
// through the saved state, never through the message itself.

import type { SavedMove } from "../../scripts/state-config.ts";
import { ASK_SLACK, isOwnSaved } from "./needs.ts";
import { SAVED_STATE } from "./persist.ts";

// wsId -> the move its chat last ended a turn on, fixed at build. A test can
// seed __STATE__ from before this map existed, so it may be missing at runtime.
function savedMoveFor(wsId: string): SavedMove | undefined {
  const map: Record<string, SavedMove> | undefined = SAVED_STATE.moves;
  return map && Object.hasOwn(map, wsId) ? map[wsId] : undefined;
}

// A turn end: Claude's Stop sets the agent idle, and the idle_prompt nudge
// about 60s later moves it to needs_input (cmux v0.64.25,
// Sources/Mobile/AgentChat/AgentChatSessionRegistry+Lifecycle.swift:89-98).
// The sidebars may read that needs_input as idle again (isIdleNudge).
const atTurnEnd = (a: Agent): boolean => a.status === "idle" || a.status === "needs_input";

/**
 * The move `a` is waiting on, or null. Pass `a` as the sidebars show it
 * (agentsOf) and `asking` from askReason. Only a turn end counts: idle or
 * needs_input, never working or ended, and never an ask. The move is current
 * while it is no older than the workspace's last prompt, ASK_SLACK aside.
 * cmux v0.64.25 moves latestAt on UserPromptSubmit (Workspace.swift:6643-6648),
 * so a new prompt, an interrupted turn and a mid-turn ask (each follows a
 * prompt) retire the move. In iMessage mode Stop also moves it
 * (WorkspacePromptSubmit.swift:75-81), at about the moment the hook saves,
 * which the slack covers. Notifications never touch it
 * (TerminalController.swift:6434), so the nudge, which restamps sinceEpoch
 * and lastActivityAt (AgentChatSessionRegistry.swift:501), leaves the move
 * showing. As with asks, when one of the workspace's agents carries the
 * move's session as its id, only that agent's turn end borrows it; before
 * the first hook the id can be a `pending-claude-` alias
 * (AgentChatSessionRegistry.swift:519-553), and then the move belongs to
 * the workspace.
 */
export function waitingMove(a: Agent | null | undefined, w: Workspace | undefined, asking: boolean): SavedMove | null {
  if (!a || !w || asking || !atTurnEnd(a)) return null;
  const saved = savedMoveFor(w.id);
  if (!saved || saved.epoch < (w.latestAt ?? 0) - ASK_SLACK) return null;
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
