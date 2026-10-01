// The selected workspace's PR checks, their summary line, and the Fix
// action that sends a failing check to the agent.
// Pure reads of `data`, so each is testable alone.

import type { CheckState } from "../../scripts/state-config.ts";
import { NUDGE_WINDOW, waitingMove } from "../shared/move.ts";
import { askReason } from "../shared/needs.ts";
import { prInk } from "../shared/pr-colors.ts";
import { checksOf } from "../shared/prs.ts";
import { nowEpoch } from "../shared/time.ts";

import { type Current, cur, current, currentPr, currentPrDim } from "./model.ts";
import { CHECK_DOT, T } from "./theme.ts";

// Checks

export interface CheckRow {
  key: string;
  name: string;
  state: CheckState;
}

/**
 * Rows for saved checks, keyed by name so a check keeps its row when the
 * poller re-sorts by state. Two checks can share a name (one per workflow),
 * so a repeat takes its count among same-named checks.
 */
export function checkRows(list: readonly { name: string; state: CheckState }[]): CheckRow[] {
  const seen = new Map<string, number>();
  return list.map((c) => {
    const n = seen.get(c.name) ?? 0;
    seen.set(c.name, n + 1);
    return { key: "c:" + c.name + ":" + n, name: c.name, state: c.state };
  });
}

/** The selected workspace's CI checks, as the poller last saved them. */
export const checks = computed((): CheckRow[] => checkRows(checksOf(cur().ws)));

/** The checks' summary line under the PR: its words, mark and colour. */
export interface ChecksSummary {
  text: string;
  /** An SF Symbol, in the same colour as the words. */
  mark: string;
  color: string;
}

type NotPassing = Exclude<CheckState, "pass">;

// The states that are not passing, worst first: the summary counts them
// in this order and takes the first one present for its colour.
const NOT_PASSING: readonly NotPassing[] = ["fail", "pending"];

const SUMMARY_WORD: Record<NotPassing, string> = { fail: "failing", pending: "running" };

const SUMMARY_MARK: Record<CheckState, string> = { pass: "checkmark.circle", fail: "xmark.circle", pending: "clock" };

const SUMMARY_COLOR: Record<CheckState, string> = { pass: T.greenText, fail: T.redText, pending: T.blueText };

const summaryIn = (state: CheckState, text: string): ChecksSummary => ({
  text,
  mark: SUMMARY_MARK[state],
  color: SUMMARY_COLOR[state],
});

// A line with no verdict: no checks, or none in a state the summary knows.
const neutral = (text: string): ChecksSummary => ({ text, mark: "minus.circle", color: T.tertiary });

function passedLine(n: number, dim: boolean): ChecksSummary {
  const line = summaryIn("pass", n === 1 ? "1 check passed" : "All " + n + " checks passed");
  // A stale pass drops to grey, as a stale ready chip does (shownHealth).
  return dim ? { ...line, color: prInk("quiet") } : line;
}

/**
 * The checks in one line: "All 3 checks passed" (one alone reads "1 check
 * passed") in green only when every check passed, else the checks not
 * passing, counted worst first ("1 failing · 2 running"), in the worst
 * one's colour. With `dim` (the PR's data is stale) a pass turns grey; the
 * card also fades the line. "No checks", with no verdict, when there are
 * none, though the card hides it then.
 */
export function checksSummary(rows: readonly CheckRow[], dim = false): ChecksSummary {
  if (rows.length === 0) return neutral("No checks");
  if (rows.every((c) => c.state === "pass")) return passedLine(rows.length, dim);
  const counts = NOT_PASSING.map((s) => ({ s, n: rows.filter((c) => c.state === s).length })).filter((x) => x.n);
  const worst = counts[0];
  if (!worst) return neutral(rows.filter((c) => c.state !== "pass").length + " not passed");
  return summaryIn(worst.s, counts.map((x) => x.n + " " + SUMMARY_WORD[x.s]).join(" · "));
}

/** The selected workspace's checks summary, grey on a stale pass. */
export const checksLine = computed((): ChecksSummary => checksSummary(checks(), currentPrDim()));

/** The checks listed under the summary: only those not passing, since the summary counts the rest. */
export const openChecks = computed((): CheckRow[] => checks().filter((c) => c.state !== "pass"));

const CHECK_WORD: Record<CheckState, string> = { pass: "passed", fail: "failed", pending: "running" };

export const checkWord = (c: CheckRow): string => CHECK_WORD[c.state];

export const checkDot = (c: CheckRow): string => CHECK_DOT[c.state];

// ---- Fix a failing check ----------------------------------------------------

/** Where a Fix tap types: the workspace's most active agent's terminal. */
export interface FixTarget {
  wsId: string;
  surfaceId: string;
  pr: number;
  /** The agent's current status spell, so one tap hides Fix until it ends. */
  spell: string;
}

// The agent as cmux sends it, not as agentsOf shows it: a dismissed ask reads
// idle there, yet its permission prompt is still on screen and would take the
// typed words as its answer.
function rawAgent(c: Current): Agent | undefined {
  const id = c.a?.id;
  return id === undefined ? undefined : (c.ws.agents ?? []).find((x) => x?.id === id);
}

// Idle is only ever a turn end: Claude's Stop sets it, an ask never does.
// needs_input is an ask until proven otherwise, since an ask reads the same
// until its saved entry reaches a build, and an unhooked one never does. It
// counts as a turn only when this session's saved turn end (shared/move.ts)
// is current and the nudge at most NUDGE_WINDOW after it explains the spell.
function canType(a: Agent, w: Workspace): boolean {
  if (a.status === "idle") return true;
  if (a.status !== "needs_input" || !a.sinceEpoch) return false;
  const move = waitingMove(a, w, askReason(a, w) !== null);
  return !!move && a.sinceEpoch - move.epoch <= NUDGE_WINDOW;
}

// sinceEpoch alone: lastActivityAt moves on every hook event, a paste's
// included, so it would end the hold before the agent starts working.
const spellOf = (a: Agent): string => `${a.id}:${a.status}:${a.sinceEpoch ?? ""}`;

// cmux() reports nothing back, so a hold also lapses after this long: a
// dropped Enter, or a spell with no start time, brings Fix back.
const FIX_HOLD = 90;

// wsId -> the spell a Fix was sent in and when. Not reactive: reads call
// fixTick(), writes set it.
const fixSent = new Map<string, { spell: string; at: number }>();
const [fixTick, setFixTick] = signal(0);

function held(wsId: string, spell: string): boolean {
  const sent = fixSent.get(wsId);
  return !!sent && sent.spell === spell && nowEpoch() - sent.at < FIX_HOLD;
}

/**
 * The selected workspace's Fix target, or null while Fix must not show:
 * the PR not open or its checks stale, no terminal, the agent working,
 * asking or ended, or a Fix sent in this spell less than FIX_HOLD ago.
 */
export const fixTarget = computed((): FixTarget | null => {
  fixTick();
  const c = current();
  const pr = currentPr();
  const a = c ? rawAgent(c) : undefined;
  if (!c || pr?.status !== "open" || currentPrDim() || !a?.surfaceId || !canType(a, c.ws)) return null;
  const spell = spellOf(a);
  return held(c.ws.id, spell) ? null : { wsId: c.ws.id, surfaceId: a.surfaceId, pr: pr.number, spell };
});

/** Whether a check row shows Fix: failed, with an agent that can take it. */
export const canFix = (c: CheckRow): boolean => c.state === "fail" && !!fixTarget();

/** What Fix types into the agent for a failed check on PR `pr`. */
export const fixPrompt = (check: string, pr: number): string =>
  `The ${check} check failed on PR #${pr}. Find its run with gh pr checks ${pr}, ` +
  `read the log with gh run view <run-id> --log-failed, fix the cause, push, and tell me what it was.`;

/** Types the Fix prompt for `check` into the agent and presses Enter. */
export function sendFix(check: string): void {
  const t = fixTarget();
  if (!t) return;
  const at = { workspace_id: t.wsId, surface_id: t.surfaceId };
  cmux("surface.send_text", { ...at, text: fixPrompt(check, t.pr) });
  cmux("surface.send_key", { ...at, key: "enter" });
  fixSent.set(t.wsId, { spell: t.spell, at: nowEpoch() });
  setFixTick(fixTick() + 1);
}
