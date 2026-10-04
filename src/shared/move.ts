// What a chat wants from Jon when its turn ends: the "Your move" line that
// scripts/hooks/report-move.ts saves, and how big a job answering it is.
// cmux keeps only the start of a message, so the line reaches the sidebar
// through the workspace's description, which cmux sends live, and through
// the saved state when setting the description failed.

import { moveOfDescription, type SavedMove } from "../../scripts/state-config.ts";
import { SAVED_STATE } from "./persist.ts";
import { savedFor } from "./saved.ts";

// The move `w`'s chat last ended a turn on: the description's or the saved
// one, whichever is newer, since a failed description write falls back to
// the saved map and leaves an older description behind. The saved map is
// fixed at build, and a test can seed __STATE__ from before it existed, so
// it may be missing at runtime.
function savedMoveFor(w: Workspace): SavedMove | undefined {
  const map: Record<string, SavedMove> | undefined = SAVED_STATE.moves;
  const saved = map && Object.hasOwn(map, w.id) ? map[w.id] : undefined;
  const live = moveOfDescription(w.description) ?? undefined;
  if (!live || !saved) return live ?? saved;
  return saved.epoch > live.epoch ? saved : live;
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
  return savedFor(savedMoveFor(w), a, w, promptAt, ownsMove);
}

// Nothing to answer, so no size. "Nothing follows" is different: it ends in /clear.
const NOTHING_WAITS = /nothing (?:else )?waits on you/i;
// "Your move: nothing. Waiting until CI lands.": the bare word, then a stop.
// "nothing pending, /clear now" and "nothing follows" still ask something.
const NOTHING_FIRST = /^nothing[.:]/i;

/**
 * True when the move asks nothing of Jon: the reply ended on "Nothing for
 * you:" (saved as idle), or on the older "Your move: nothing. Waiting until
 * X." or "nothing waits on you". "Nothing follows" is not one: it ends in
 * /clear. A reply that laid out decisions always asks something, whatever
 * its last line says.
 */
export const asksNothing = (m: Pick<SavedMove, "text" | "idle" | "decisions">): boolean =>
  !((m.decisions ?? 0) > 0) && (m.idle === true || NOTHING_WAITS.test(m.text) || NOTHING_FIRST.test(m.text));

/**
 * How long after a saved turn end the idle_prompt nudge may turn it into
 * needs_input: about 60s on cmux 0.64.25 (docs/state-loop.md), doubled.
 */
export const NUDGE_WINDOW = 120;

/**
 * The move behind `a`'s needs_input when it asks nothing of Jon, or null.
 * Pass `a` as cmux sends it, and only when it is not asking: the idle nudge
 * lands about 60s after a turn that ended on "Nothing for you", and that
 * turn waits on the agent's own background work, not on Jon. Only that
 * nudge: a later needs_input with no prompt between (the agent woke on its
 * own and stopped to ask) is past NUDGE_WINDOW and still needs him.
 */
export function quietTurn(a: Agent, w: Workspace | undefined): SavedMove | null {
  if (a.status !== "needs_input" || !a.sinceEpoch) return null;
  const m = quietMove(a, w);
  return m && a.sinceEpoch - m.epoch <= NUDGE_WINDOW ? m : null;
}

/** The move `a`'s turn ended on when it asks nothing of Jon ("Nothing for you"), or null. */
export function quietMove(a: Agent, w: Workspace | undefined): SavedMove | null {
  const m = waitingMove(a, w, false);
  return m && asksNothing(m) ? m : null;
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

export function moveSize(m: Pick<SavedMove, "text" | "decisions" | "idle">): MoveSize | null {
  if ((m.decisions ?? 0) > 0) return "decide";
  if (asksNothing(m)) return null;
  if (REVIEW.test(m.text)) return "review";
  if (QUICK.test(m.text)) return "quick";
  return null;
}

/** The size chip's words: "Quick", "Review", "Decide · 2". */
export function moveSizeText(size: MoveSize, decisions = 0): string {
  if (size === "decide") return decisions > 1 ? "Decide · " + decisions : "Decide";
  return size === "quick" ? "Quick" : "Review";
}
