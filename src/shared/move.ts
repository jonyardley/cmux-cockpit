// What a chat wants from Jon when its turn ends: the "Your move" line that
// scripts/hooks/report-move.ts saves, and how big a job answering it is.
// cmux keeps only the start of a message, so the line reaches the sidebar
// through the saved state, never through the message itself.

import type { SavedMove } from "../../scripts/state-config.ts";
import { savedFor } from "./needs.ts";
import { SAVED_STATE } from "./persist.ts";

// wsId -> the move its chat last ended a turn on, fixed at build. A test can
// seed __STATE__ from before this map existed, so it may be missing at runtime.
function savedMoveFor(wsId: string): SavedMove | undefined {
  const map: Record<string, SavedMove> | undefined = SAVED_STATE.moves;
  return map && Object.hasOwn(map, wsId) ? map[wsId] : undefined;
}

// A turn end: Claude's Stop sets the agent idle, and the idle_prompt nudge
// about 60s later moves it to needs_input, restamping sinceEpoch and
// lastActivityAt. The cmux facts behind this and waitingMove are in
// docs/state-loop.md, section "What cmux does (v0.64.25)".
const atTurnEnd = (a: Agent): boolean => a.status === "idle" || a.status === "needs_input";

// A move is `a`'s only when `a` is the Claude session that saved it. A new
// session in the same workspace (/clear, a relaunch, --resume), an agent
// still on its `pending-claude-` alias, a codex agent, or a move saved with
// no session: none of them borrows it, since hiding a move is the safe side.
const ownsMove = (saved: SavedMove, a: Agent): boolean =>
  saved.session !== undefined && a.kind === "claude" && a.id === saved.session;

/**
 * The move `a` is waiting on, or null. Pass `a` as the sidebars show it
 * (agentsOf) and `asking` from askReason. Only a turn end counts: idle or
 * needs_input, never working or ended, and never an ask. The move is current
 * while it is no older than the workspace's last prompt (latestAt, which
 * cmux moves on UserPromptSubmit and never on a notification), HOOK_SLACK
 * aside, so a new prompt, an interrupted turn and a mid-turn ask retire it
 * and the nudge does not. With no latestAt there is no telling how old the
 * move is, so none shows. It must also be `a`'s own (ownsMove).
 */
export function waitingMove(a: Agent | null | undefined, w: Workspace | undefined, asking: boolean): SavedMove | null {
  if (!a || !w || asking || !atTurnEnd(a)) return null;
  const promptAt = w.latestAt ?? 0;
  if (promptAt <= 0) return null;
  return savedFor(savedMoveFor(w.id), a, w, promptAt, ownsMove);
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
