// The selected workspace's PR checks, their summary line, and the Fix
// action that sends a failing check to the agent.
// Reads of `data`, except sendFix, which sends the agent a message.

import type { CheckState } from "../../scripts/state-config.ts";
import { QUIET_INK } from "../shared/pr-colors.ts";
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
 * Each saved check with its row key, keyed by name so a check keeps its row
 * when the poller re-sorts by state. Two checks can share a name (one per
 * workflow), so a repeat takes its count among same-named checks.
 */
export function keyedChecks<C extends { name: string }>(list: readonly C[]): { key: string; check: C }[] {
  const seen = new Map<string, number>();
  return list.map((check) => {
    const n = seen.get(check.name) ?? 0;
    seen.set(check.name, n + 1);
    return { key: "c:" + check.name + ":" + n, check };
  });
}

/** Rows for saved checks, under keyedChecks' keys. */
export function checkRows(list: readonly { name: string; state: CheckState }[]): CheckRow[] {
  return keyedChecks(list).map(({ key, check }) => ({ key, name: check.name, state: check.state }));
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
  // A stale pass drops to grey, as a stale ready chip does (shownTone).
  return dim ? { ...line, color: QUIET_INK } : line;
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

/** Where a Fix tap sends its message: the workspace's most active agent. */
export interface FixTarget {
  wsId: string;
  pr: number;
  /** The agent's current status spell, so one tap hides Fix until it ends. */
  spell: string;
}

// The agent as cmux sends it, not as agentsOf shows it: a dismissed ask reads
// idle there, so its spell would not change when the ask is answered.
function rawAgent(c: Current): Agent | undefined {
  const id = c.a?.id;
  return id === undefined ? undefined : (c.ws.agents ?? []).find((x) => x?.id === id);
}

// sinceEpoch alone: lastActivityAt moves on every hook event, a paste's
// included, so it would end the hold before the agent starts working.
const spellOf = (a: Agent): string => `${a.id}:${a.status}:${a.sinceEpoch ?? ""}`;

// cmux() reports nothing back, so a hold also lapses after this long: a
// dropped message, or a spell with no start time, brings Fix back.
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
 * the PR not open or its checks stale, no agent or an ended one, or a Fix
 * sent in this spell less than FIX_HOLD ago. A working or asking agent still
 * shows it: the message waits for its next step or the open prompt to close.
 */
export const fixTarget = computed((): FixTarget | null => {
  fixTick();
  const c = current();
  const pr = currentPr();
  const a = c ? rawAgent(c) : undefined;
  if (!c || pr?.status !== "open" || currentPrDim() || !a || a.status === "ended") return null;
  const spell = spellOf(a);
  return held(c.ws.id, spell) ? null : { wsId: c.ws.id, pr: pr.number, spell };
});

/** Whether a check row shows Fix: failed, with an agent that can take it. */
export const canFix = (c: CheckRow): boolean => c.state === "fail" && !!fixTarget();

/** What Fix sends the agent for a failed check on PR `pr`. */
export const fixPrompt = (check: string, pr: number): string =>
  `The ${check} check failed on PR #${pr}. Find its run with gh pr checks ${pr}, ` +
  `read the log with gh run view <run-id> --log-failed, fix the cause, push, and tell me what it was.`;

/** Sends the Fix prompt for `check` to the agent as a cmux agent message. */
export function sendFix(check: string): void {
  const t = fixTarget();
  if (!t) return;
  cmux("agent.message.send", { target: t.wsId, body: fixPrompt(check, t.pr), from: "cockpit" });
  fixSent.set(t.wsId, { spell: t.spell, at: nowEpoch() });
  setFixTick(fixTick() + 1);
}
