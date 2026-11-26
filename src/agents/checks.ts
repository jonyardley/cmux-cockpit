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
  /** The agent's own terminal when known, so the message reaches the agent
   * chosen here rather than whichever one cmux resolves the workspace to. */
  target: string;
  pr: number;
}

// The agent as cmux sends it, not as agentsOf shows it: a dismissed ask reads
// idle there, yet it is still asking.
function rawAgent(c: Current): Agent | undefined {
  const id = c.a?.id;
  return id === undefined ? undefined : (c.ws.agents ?? []).find((x) => x?.id === id);
}

// Only Claude sessions are known to take cmux agent messages, and only while
// live: no status at all is an agent cmux has told us nothing about.
const LIVE: ReadonlySet<string> = new Set(["idle", "working", "needs_input"]);
const canMessage = (a: Agent): boolean => a.kind === "claude" && a.status !== undefined && LIVE.has(a.status);

// cmux() reports nothing back, so a hold also lapses after this long: a
// dropped message, or an agent that never gets to it, brings Fix back.
const FIX_HOLD = 15 * 60;

// One run of a check: a new run changes its queued or started time, a result
// its state. A Fix holds until this moves, whatever the agent does meanwhile.
const runOf = (c: { state: CheckState; queued?: number; started?: number }): string =>
  `${c.state}:${c.queued ?? ""}:${c.started ?? ""}`;

// "ws#pr#row key" -> the run a Fix was sent for and when. Not reactive:
// reads call fixTick(), writes set it.
const fixSent = new Map<string, { run: string; at: number }>();
const [fixTick, setFixTick] = signal(0);

const holdKey = (t: FixTarget, row: CheckRow): string => `${t.wsId}#${t.pr}#${row.key}`;

// The saved run behind a row, found by the row's key.
function runFor(row: CheckRow): string {
  const saved = keyedChecks(checksOf(cur().ws)).find((k) => k.key === row.key);
  return saved ? runOf(saved.check) : runOf(row);
}

// A hold seen past its run or its time is dropped as it is read, so a check
// that goes from failed to running and back to failed shows Fix again even
// when the poller kept the same run times.
function held(t: FixTarget, row: CheckRow): boolean {
  fixTick();
  const key = holdKey(t, row);
  const sent = fixSent.get(key);
  if (!sent) return false;
  if (sent.run === runFor(row) && nowEpoch() - sent.at < FIX_HOLD) return true;
  fixSent.delete(key);
  return false;
}

/**
 * The selected workspace's Fix target, or null while Fix must not show:
 * the PR not open or its checks stale, or no live Claude agent. A working or
 * asking agent still shows it: the message waits for its next step or the
 * open prompt to close.
 */
export const fixTarget = computed((): FixTarget | null => {
  const c = current();
  const pr = currentPr();
  const a = c ? rawAgent(c) : undefined;
  if (!c || pr?.status !== "open" || currentPrDim() || !a || !canMessage(a)) return null;
  return { wsId: c.ws.id, target: a.surfaceId || c.ws.id, pr: pr.number };
});

/** Whether a check row shows Fix: failed, with an agent that can take it,
 * and no Fix yet sent for this run of the check. */
export function canFix(c: CheckRow): boolean {
  const t = fixTarget();
  // held() before the state test, so a running check's read drops its hold.
  return !!t && !held(t, c) && c.state === "fail";
}

const MAX_CHECK_LABEL = 100;

/**
 * A check's name made safe to quote in a prompt. A PR branch can set its
 * workflow's check names, so only letters, digits, space and `._/:()-` stay,
 * whitespace closes up, and it is cut to MAX_CHECK_LABEL characters.
 */
export function checkLabel(name: string): string {
  const kept = name
    .replace(/[^A-Za-z0-9 ._/:()-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return kept.slice(0, MAX_CHECK_LABEL).trim() || "unnamed";
}

/** What Fix sends the agent for a failed check on PR `pr`. */
export const fixPrompt = (check: string, pr: number): string =>
  `The check named "${checkLabel(check)}" failed on PR #${pr}. Find its run with gh pr checks ${pr}, ` +
  `read the log with gh run view <run-id> --log-failed, fix the cause, push, and tell me what it was.`;

// The native Cockpit's sender name (native/runner/src/outbox.rs MESSAGE_FROM).
const MESSAGE_FROM = "Cockpit";

/** Sends the Fix prompt for `row` to the agent as a cmux agent message, and
 * hides Fix for that check at once until its run changes. */
export function sendFix(row: CheckRow): void {
  const t = fixTarget();
  if (!t || !canFix(row)) return;
  cmux("agent.message.send", { target: t.target, body: fixPrompt(row.name, t.pr), from: MESSAGE_FROM });
  fixSent.set(holdKey(t, row), { run: runFor(row), at: nowEpoch() });
  setFixTick(fixTick() + 1);
}
