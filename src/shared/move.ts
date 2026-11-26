// What a chat wants from Jon when its turn ends: the "Your move" line that
// scripts/hooks/report-move.ts saves, and how big a job answering it is.
// cmux keeps only the start of a message, so the line reaches the sidebar
// through the workspace's description, which cmux sends live, and through
// the saved state when setting the description failed.

import { moveOfDescription, type SavedMove } from "../../scripts/state-config.ts";
import { SAVED_STATE } from "./persist.ts";
import { agentsRun } from "./running.ts";
import { savedFor } from "./saved.ts";

// The move a description carries, parsed once per distinct description:
// moveOf runs several times per card on every tick.
const parsed = new Map<string, SavedMove | undefined>();
function liveMove(d: string | undefined): SavedMove | undefined {
  if (d === undefined) return undefined;
  if (parsed.has(d)) return parsed.get(d);
  if (parsed.size >= 64) parsed.clear();
  const m = moveOfDescription(d) ?? undefined;
  parsed.set(d, m);
  return m;
}

// The move `w`'s chat last ended a turn on: the description's or the saved
// one, whichever is newer, since a failed description write falls back to
// the saved map and leaves an older description behind. The saved map is
// fixed at build, and a test can seed __STATE__ from before it existed, so
// it may be missing at runtime.
function savedMoveFor(w: Workspace): SavedMove | undefined {
  const map: Record<string, SavedMove> | undefined = SAVED_STATE.moves;
  const saved = map && Object.hasOwn(map, w.id) ? map[w.id] : undefined;
  const live = liveMove(w.description);
  if (!live || !saved) return live ?? saved;
  return saved.epoch > live.epoch ? saved : live;
}

// A turn end: Claude's Stop sets the agent idle, and on cmux 0.65.2 the
// idle reminder about 60s later keeps it so (issue #422). needs_input
// counts too, for an ask that comes with no prompt since the turn ended,
// which freshAsk (shared/needs.ts) reads against it. The cmux facts behind this and waitingMove are in
// docs/state-loop.md, section "What cmux does (v0.65.2)".
const atTurnEnd = (a: Agent): boolean => a.status === "idle" || a.status === "needs_input";

// A move is `a`'s only when `a` is the Claude session that saved it. A new
// session in the same workspace (/clear, a relaunch, --resume), an agent
// still on its `pending-claude-` alias, a codex agent, or a move saved with
// no session: none of them borrows it, since hiding a move is the safe side.
const ownsMove = (saved: SavedMove, a: Agent): boolean =>
  saved.session !== undefined && a.kind === "claude" && a.id === saved.session;

/**
 * The move `a` is waiting on, or null. Pass `a` as the agents panel shows it
 * (agentsOf) and `asking` from askReason. Only a turn end counts: idle or
 * needs_input, never working or ended, and never an ask. The move is current
 * while it is no older than the workspace's last prompt (latestAt, which
 * cmux moves on UserPromptSubmit and never on a notification), HOOK_SLACK
 * aside, so a new prompt, an interrupted turn and a mid-turn ask retire it
 * and a notification does not. With no latestAt there is no telling how old the
 * move is, so none shows. It must also be `a`'s own (ownsMove).
 */
export function waitingMove(a: Agent | null | undefined, w: Workspace | undefined, asking: boolean): SavedMove | null {
  if (!a || !w || asking || !atTurnEnd(a)) return null;
  const promptAt = w.latestAt ?? 0;
  if (promptAt <= 0) return null;
  return savedFor(savedMoveFor(w), a, w, promptAt, ownsMove);
}

// Nothing to answer. "Nothing follows" is different: it ends in /clear.
const NOTHING_WAITS = /nothing (?:else )?waits on you/i;
// "Your move: nothing. Waiting until CI lands.": the bare word, then a stop.
// "nothing pending, /clear now" and "nothing follows" still ask something.
const NOTHING_FIRST = /^nothing[.:]/i;

/**
 * True when the move asks nothing of Jon: the reply ended on "Nothing for
 * you:" (saved as idle), or on the older "Your move: nothing. Waiting until
 * X." or "nothing waits on you". "Nothing follows" is not one: it ends in
 * /clear. A reply that laid out decisions always asks something, and so
 * does one a model's verdict says waits. A quiet verdict alone is not
 * enough: like noAsk it only holds the turn while agents run (asksNothingYet).
 */
export const asksNothing = (m: Pick<SavedMove, "text" | "idle" | "decisions" | "verdict">): boolean => {
  if ((m.decisions ?? 0) > 0 || m.verdict === "waits") return false;
  return m.idle === true || NOTHING_WAITS.test(m.text) || NOTHING_FIRST.test(m.text);
};

// A reply that asked nothing by its wording (noAsk) or by the model's verdict.
const quietReply = (m: SavedMove): boolean => (m.verdict === undefined ? m.noAsk === true : m.verdict === "quiet");

/**
 * True when the move asks nothing of Jon for now: asksNothing, or a reply
 * that asked nothing at all (noAsk, or a quiet verdict) while `a`'s chat
 * still runs subagents by the core's saved verdict. Once they stop the turn
 * waits on him again, so a quiet chat never hides for good. The Cockpit's
 * `asks_nothing_yet` (native/core/src/moves.rs).
 */
export const asksNothingYet = (m: SavedMove, a: Agent, w: Workspace | undefined): boolean =>
  asksNothing(m) || (quietReply(m) && !((m.decisions ?? 0) > 0) && agentsRun(a, w));
