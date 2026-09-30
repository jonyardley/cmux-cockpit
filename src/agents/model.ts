// The agents panel's data: the selected workspace in detail (and its
// question, when its agent needs you), every PR, and what agents published.
// Who is working and who is idle lives on the cockpit's cards, not here.
// Pure reads of `data`, so each is testable alone.

import type { CheckState, SavedPublished } from "../../scripts/state-config.ts";
import { byActivity, mostActive } from "../shared/activity.ts";
import { placeholderIds } from "../shared/anchors.ts";
import { prFreshness } from "../shared/freshness.ts";
import { type Last, markLast } from "../shared/list.ts";
import { NUDGE_WINDOW, waitingMove } from "../shared/move.ts";
import { agentsOf, askReason } from "../shared/needs.ts";
import { STATUS_TEXT } from "../shared/palette.ts";
import { prInk } from "../shared/pr-colors.ts";
import { type Project, projectOf, savedProjectFor } from "../shared/projects.ts";
import {
  checksOf,
  fromPoller,
  originOf,
  type PrHealth,
  type PrSummary,
  prSummary,
  prsOf,
  savedOwnPrs,
  summaryOf,
} from "../shared/prs.ts";
import { savedPublished } from "../shared/published.ts";
import { quietSuffix } from "../shared/quiet.ts";
import { childRunning, pairLive, type SavedRun, savedRunning, savedRuns } from "../shared/subagents.ts";
import { cardMessage, promptText, readable } from "../shared/text.ts";
import { ageSince, finishedAt, nowEpoch } from "../shared/time.ts";
import { displayTitle } from "../shared/titles.ts";
import { countTint, type HaloStatus, haloColor, type PillColors } from "../shared/ui.ts";
import { ASKING_WORD, NO_AGENT_WORD, STATUS_WORD, withAge } from "../shared/words.ts";
import { CHECK_DOT, STATUS_DOT, T } from "./theme.ts";

// Capped lists

/** How many of `total` rows a cap of `max` leaves out; 0 when none are. */
export const moreThan = (total: number, max: number): number => Math.max(0, total - max);

/** markLast, except that while the list overflows its cap (`more` > 0) no
 * row is last: a closing "+N more" or, once open, "Show less" line follows,
 * so the final row keeps its rule above it. */
export function markLastBefore<T>(rows: T[], more: number): Last<T>[] {
  return more > 0 ? rows.map((e) => ({ ...e, last: false })) : markLast(rows);
}

/** The cards whose "+N more" line can be tapped open (#109). */
export type ListKey = "prs" | "made";

// Which cards are open past their cap, each with what it was opened for:
// Made here with the selected workspace, since its rows depend on it, so
// selecting another workspace shows that one folded. Not saved: a reload
// folds them.
const [openLists, setOpenLists] = signal<ReadonlyMap<ListKey, string>>(new Map());

const selectedId = (): string => (data.workspaces() ?? []).find((w) => w.selected)?.id ?? "";
const openFor = (k: ListKey): string => (k === "made" ? selectedId() : "");

export const isExpanded = (k: ListKey): boolean => {
  const at = openLists().get(k);
  return at !== undefined && at === openFor(k);
};

/** Opens a card past its cap, or folds it back. */
export function toggleExpanded(k: ListKey): void {
  const next = new Map(openLists());
  if (isExpanded(k)) next.delete(k);
  else next.set(k, openFor(k));
  setOpenLists(next);
}

/** The line a capped card ends in: "+N more" while cut, "Show less" while
 * open past its cap, "" when the list fits. `over` is how many rows the cap
 * leaves out when the card is folded. */
export function footText(over: number, expanded: boolean): string {
  if (over <= 0) return "";
  return expanded ? "Show less" : "+" + over + " more";
}

// ---- This workspace -------------------------------------------------------
// This panel has no author state of its own (a sidebar cannot see another
// sidebar's), so it follows selection instead.

export interface Current {
  ws: Workspace;
  a: Agent | null;
  /** Most active first. */
  agents: Agent[];
  /** The same agents in cmux's own order. */
  inOrder: Agent[];
  project: Project;
}

export const current = computed((): Current | null => {
  const w = (data.workspaces() ?? []).find((x) => x.selected);
  if (!w) return null;
  const inOrder = agentsOf(w);
  const agents = [...inOrder].sort(byActivity);
  return { ws: w, a: agents[0] ?? null, agents, inOrder, project: savedProjectFor(w.directory, w.id) };
});

/** The This workspace heading, with the selected workspace's project:
 * "THIS WORKSPACE · Cockpit"; plain "THIS WORKSPACE" with no project. The
 * workspace's own name is left to the highlighted card on the left. */
export const currentHeading = computed((): string => {
  const name = current()?.project.name;
  return name ? "THIS WORKSPACE · " + name : "THIS WORKSPACE";
});

/** current(), or an empty stand-in so views never branch on null. */
export const cur = (): Current =>
  current() ?? { ws: { id: "" }, a: null, agents: [], inOrder: [], project: projectOf("") };

/** The selected workspace's open question. */
export interface Ask {
  /** The most active asking agent: Open chat focuses its terminal. */
  a: Agent;
  /** The line over the buttons: "2 agents need you" when several do,
   * else why it is asking ("allow git push?"), else the agent's words, or
   * "" when there are none beyond the generic "waiting for your reply", or
   * when they may be another agent's. */
  text: string;
  /** How many agents in the workspace are asking. */
  count: number;
  /** Open chat shows only with a terminal to focus: without one it would only
   * select the workspace, which is already selected. */
  canOpenChat: boolean;
  /** Dismiss clears every ask in the workspace, so it says so when there are several. */
  dismissLabel: string;
}

// The workspace's latestMessage is workspace-wide (Agent carries no message
// of its own), so it is the asker's words only when no other live agent
// could have written it.
function askText(c: Current, count: number): string {
  if (count > 1) return `${count} agents need you`;
  const reason = askReason(c.a, c.ws);
  if (reason) return reason;
  const live = c.agents.filter((a) => a.status !== "ended").length;
  return live === 1 ? cardMessage(c.ws) : "";
}

/** Whether the selected workspace needs you, by the Needs you strip's rule:
 * its most active agent reads needs_input once nudges and dismissals are
 * applied (src/shared/needs.ts). Null otherwise. */
export const currentAsk = computed((): Ask | null => {
  const c = current();
  if (c?.a?.status !== "needs_input") return null;
  const count = c.agents.filter((a) => a.status === "needs_input").length;
  return {
    a: c.a,
    text: askText(c, count),
    count,
    canOpenChat: !!c.a.surfaceId,
    dismissLabel: count > 1 ? "Dismiss all" : "Dismiss",
  };
});

/** The card's quiet message line; empty while the question block shows the words. */
export const cardLine = computed((): string => (currentAsk() ? "" : cardMessage(cur().ws)));

/** The card's Asked line: the last prompt Jon gave, above the agent's last
 * message (issue #80), kept through a harness turn (shared/text.ts). */
export const askedLine = computed((): string => promptText(cur().ws));

/** Idle and no agent draw a hollow ring, as the left sidebar does. */
export const hollowDot = (a: Agent | null): boolean => !a || a.status === "idle";

// The halo colour for each of shared/ui.ts's two haloed statuses; every
// other status reads "clear" (haloColor falls back to it via haloStatus),
// matching the left sidebar's status.ts.
const HALO_COLOR: Record<HaloStatus, string> = { working: T.blueHalo, needs_input: T.clayHalo };

// Whether `a`, one of `w`'s agents (the selected workspace's by default),
// is asking rather than waiting for its turn (issue #81).
const isAsking = (a: Agent | null, w: Workspace): boolean => askReason(a, w) !== null;

/** Board 1's soft halo round a live dot: working and needs only, as the left
 * sidebar rings them, amber while the agent is asking. */
export const haloFor = (a: Agent | null, w: Workspace = cur().ws): string =>
  isAsking(a, w) ? T.amberHalo : haloColor(a?.status, HALO_COLOR);

/** An agent's dot: its status colour, amber while asking, grey without one. */
export function dotFor(a: Agent | null, w: Workspace = cur().ws): string {
  if (!a) return T.grey;
  return isAsking(a, w) ? T.amber : (a.status && STATUS_DOT[a.status]) || T.grey;
}

/** The card head's status colour, amber while asking. */
export function statusColor(a: Agent | null, w: Workspace = cur().ws): string {
  if (!a) return T.secondary;
  return isAsking(a, w) ? T.amberText : (a.status && STATUS_TEXT[a.status]) || T.secondary;
}

// Idle and ended agents count from when they finished (issue #98), as the
// cockpit's cards do; the rest from the start of their current status.
function statusSince(a: Agent): number | undefined {
  return a.status === "idle" || a.status === "ended" ? finishedAt(a) : (a.sinceEpoch ?? a.lastActivityAt);
}

/** Short form for agent rows, the card head's words in lower case: "working 12m", "finished 3m". */
export function statusLine(a: Agent | null, w: Workspace = cur().ws): string {
  return a ? withAge(statusWord(a, w).toLowerCase(), sinceAge(a)) : "";
}

/** The one age format the card shows: "<1m", "12m", counted from the
 * start of the status (idle and ended from when they finished); "" without
 * an agent or a timestamp. */
export function sinceAge(a: Agent | null): string {
  return a ? ageSince(statusSince(a)) : "";
}

/** The card head's status, in the words the cockpit uses: "Working 14m", "Asking 2m", "Finished 3m", "No agent". */
export function headStatus(a: Agent | null, w: Workspace = cur().ws): string {
  return a ? withAge(statusWord(a, w), sinceAge(a)) + quietSuffix(a, w) : NO_AGENT_WORD;
}

// The shared word for the agent's status, Asking while it asks.
const statusWord = (a: Agent, w: Workspace): string =>
  isAsking(a, w) ? ASKING_WORD : a.status ? (STATUS_WORD[a.status] ?? a.status) : NO_AGENT_WORD;

// The card's details

/** The card's faint footer: the branch, then "uncommitted changes" when
 * dirty, or "clean" only when cmux says it is ("main · clean"); the branch
 * alone when cmux does not say, the changes alone with no branch, and ""
 * with neither. cmux sends no file count, so it never says how many. */
export const branchFooter = computed((): string => {
  const w = cur().ws;
  const state = w.dirty ? "uncommitted changes" : w.dirty === false ? "clean" : "";
  return [w.branch, state].filter(Boolean).join(" · ");
});

export interface PortChip {
  key: string;
  label: string;
  url: string;
}

/** The workspace's open ports, at most three, each opening its local page. */
export const portChips = computed((): PortChip[] =>
  (cur().ws.ports ?? []).slice(0, 3).map((n) => ({ key: "p" + n, label: ":" + n, url: "http://localhost:" + n })),
);

/** The workspace's PR with its state, as the chip shows it. */
export const currentPr = computed((): PrSummary | undefined => prSummary(cur().ws));

/** The saved PR data's freshness (shared/freshness.ts) at the clock, worked
 * out once a tick for every row, the card chip and the heading's line. */
const freshness = computed(() => prFreshness(nowEpoch()));

const prStale = (): boolean => freshness().stale;

/** The workspace's PR chip dims while it is the poller's copy and that copy is stale. */
export const currentPrDim = computed((): boolean => !!currentPr() && fromPoller(cur().ws) && prStale());

// ---- This workspace's agent list -------------------------------------------

export interface AgentRow {
  key: string;
  a: Agent;
  label: string;
}

const fallbackLabel = (a: Agent): string => a.name || a.kind || "agent";

// A real title wins; otherwise agents sharing a fallback label are numbered
// in cmux's own order, ended ones included, so a number holds still as
// activity changes and as earlier agents end.
function labelsFor(inOrder: Agent[]): Map<string, string> {
  const plain = inOrder.map((a) => ({ a, title: readable(a.title), base: fallbackLabel(a) }));
  const count = new Map<string, number>();
  for (const e of plain) if (!e.title) count.set(e.base, (count.get(e.base) ?? 0) + 1);
  const seen = new Map<string, number>();
  const out = new Map<string, string>();
  for (const { a, title, base } of plain) {
    if (title || (count.get(base) ?? 0) < 2) {
      out.set(a.id, title || base);
      continue;
    }
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    out.set(a.id, `${base} ${n}`);
  }
  return out;
}

/** The selected workspace's live agents, most active first, at most 6. Ended
 * agents are left out, and the list is empty unless two or more remain: the
 * header already shows one. */
export const agentRows = computed((): Last<AgentRow>[] => {
  const { agents, inOrder } = cur();
  const live = agents.filter((a) => a.status !== "ended");
  if (live.length < 2) return [];
  const labels = labelsFor(inOrder);
  return markLast(live.slice(0, 6).map((a) => ({ key: "a:" + a.id, a, label: labels.get(a.id) ?? fallbackLabel(a) })));
});

// ---- Subagents ---------------------------------------------------------------

export interface SubagentRow {
  key: string;
  label: string;
  running: boolean;
  startedEpoch: number | undefined;
  endedEpoch: number | undefined;
  /** The session it ran under is still open, so a settled run counts as
   * finished earlier in this work rather than in a closed session. */
  liveSession: boolean;
}

// A run ranked for sorting and display, whichever source it came from.
type Ranked = SubagentRow;

// Running runs first, oldest start first; then settled ones, newest end
// first, falling back on their start when cmux sends no end.
function byRun(x: Ranked, y: Ranked): number {
  if (x.running !== y.running) return x.running ? -1 : 1;
  if (x.running) return (x.startedEpoch ?? 0) - (y.startedEpoch ?? 0);
  return (y.endedEpoch ?? y.startedEpoch ?? 0) - (x.endedEpoch ?? x.startedEpoch ?? 0);
}

// cmux's own children, ranked; empty when every agent has none, so a
// workspace with no live cmux data falls through to the saved runs. A child
// a live saved run vouches for is running whatever cmux says, and drops the
// end cmux gave it (#83).
function childRanked(agents: Agent[], vouched: Set<SubagentRun>): Ranked[] {
  return agents.flatMap((owner) =>
    (owner.children ?? []).flatMap((c, i) => {
      if (!c) return [];
      const running = childRunning(c, owner);
      const vouch = !running && vouched.has(c);
      return [
        {
          // The index stands in for a missing id; cmux keeps children oldest first.
          key: "s:" + owner.id + ":" + (c.id ?? "#" + i),
          label: readable(c.label) || "subagent",
          running: running || vouch,
          startedEpoch: c.startedEpoch,
          endedEpoch: vouch ? undefined : c.endedEpoch,
          liveSession: owner.status !== "ended",
        },
      ];
    }),
  );
}

// A saved run's owner is the workspace agent whose id matches its session,
// when there is one (unconfirmed whether cmux agent ids are Claude session
// ids); otherwise the run belongs to the workspace as a whole, whose session
// is live while any agent is. savedRunning says whether it is live, so a
// closed session never ticks on.
function savedRanked(run: SavedRun, agents: Agent[]): Ranked {
  const owner = agents.find((a) => a.id === run.session);
  return {
    key: "s:" + (owner?.id ?? "ws") + ":" + run.id,
    label: readable(run.label) || "subagent",
    running: savedRunning(run, agents),
    startedEpoch: run.startedEpoch,
    endedEpoch: run.endedEpoch,
    liveSession: owner ? owner.status !== "ended" : agents.some((a) => a.status !== "ended"),
  };
}

// cmux's children, plus the live saved runs cmux has already pruned.
function withSaved(wsId: string, agents: Agent[]): Ranked[] {
  const { vouched, unclaimed } = pairLive(wsId, agents);
  return [...childRanked(agents, vouched), ...unclaimed.map((r) => savedRanked(r, agents))];
}

/** The selected workspace's subagent runs, running first: cmux's own
 * `children` while any agent carries some, corrected by the saved runs still
 * live (pairLive, #83), else the saved runs from config/state.json (issue
 * #6). Settled runs stay until their source drops them. No clock read, so it
 * only rebuilds when the data changes; the figure is helperAge's. */
export const subagents = computed((): SubagentRow[] => {
  const { ws, agents } = cur();
  // cmux can send a children array full of holes (agentRows survives the
  // same); only a real, truthy child should count as cmux having its own
  // data, else an all-holes array would show nothing rather than fall back.
  const ranked = agents.some((a) => (a.children ?? []).some((c) => c))
    ? withSaved(ws.id, agents)
    : savedRuns(ws.id).map((r) => savedRanked(r, agents));
  return ranked.sort(byRun);
});

/** Helper lines shown at most. */
const MAX_HELPERS = 5;

const runningRuns = computed((): SubagentRow[] => subagents().filter((s) => s.running));

/** The card's Helpers lines: the running runs alone, oldest start first, at
 * most MAX_HELPERS, then helperMore. Settled ones fold into finishedLine. */
export const helpers = computed((): SubagentRow[] => runningRuns().slice(0, MAX_HELPERS));

/** How many running runs the cap leaves out, for a closing "+N more", so
 * the lines add up to the left card's helper count (#80). */
export const helperMore = computed((): number => moreThan(runningRuns().length, MAX_HELPERS));

/** The HELPERS heading's count: every running run, the lines plus
 * helperMore, so it matches the left card's "3 helpers". */
export const helperCount = computed((): number => runningRuns().length);

/** Whether the card shows its HELPERS heading and lines: only while a run
 * is running. With only settled runs, finishedLine stands alone. */
export const hasHelpers = computed((): boolean => helperCount() > 0);

/** The helpers count pill's colours: every run it counts is running, so
 * the shared tint's working blue. */
export const HELPER_PILL: PillColors = countTint("working");

/** The faint line for the settled runs of sessions still open, "1 finished
 * earlier" or "3 finished earlier"; "" when none have. A closed session's
 * runs are not counted: they belong to work that is over. */
export const finishedLine = computed((): string => {
  const n = subagents().filter((s) => !s.running && s.liveSession).length;
  return n ? n + " finished earlier" : "";
});

/** A helper line's right-hand figure, kept short so the run's name is not
 * the one cut: coarse elapsed ("4m"), or "running" without a start or clock. */
export const helperAge = (s: SubagentRow): string => ageSince(s.startedEpoch) || "running";

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

// ---- Pull requests ----------------------------------------------------------

export interface PrEntry {
  key: string;
  pr: PullRequest;
  title: string;
  /** The PR as the cards read it (shared/prs.ts), so the chip says the same on both sides. */
  summary: PrSummary | undefined;
  /** The poller's saved copy rather than cmux's own, so it can go stale. */
  saved: boolean;
  /** Its project, from the session's folder, else the repo an own PR was
   * found in; grey when neither matches one. */
  project: Project;
  /** The session it belongs to; undefined when none holds or opened it, or that chat has closed. */
  session: PrSession | undefined;
}

/** The chat a PR row names on its faint line, with that chat's status dot. */
export interface PrSession {
  name: string;
  dot: string;
  /** Idle or no agent: the dot draws as a hollow ring, as everywhere else in the panel. */
  hollow: boolean;
}

/** A PR row's number, "#134"; "" before GitHub has given it one. */
export const prNumberText = (e: Pick<PrEntry, "pr">): string => (e.pr.number ? "#" + e.pr.number : "");

/**
 * What a PR row's chip says: the PR's worst state as its card says it
 * ("1 failing", "conflicts", "draft · running", "ready", "open", "merged"),
 * or for a PR with no number, "draft" for an open draft, else its status.
 * Stale rides inside the chip, since an empty sibling Text would still cost spacing.
 */
export function prChipText(e: Pick<PrEntry, "pr" | "summary">): string {
  const { pr, summary } = e;
  const word = summary ? summary.state : pr.status === "open" && pr.draft ? "draft" : pr.status;
  return [word, pr.stale ? "stale" : undefined].filter(Boolean).join(" · ");
}

/** A PR row chip's health, for its colour. */
export const prChipHealth = (e: Pick<PrEntry, "summary">): PrHealth => e.summary?.health ?? "quiet";

// A PR with no status ranks as open: only cmux sends one, for a PR a
// workspace holds now, and the poller's own PRs always carry theirs.
const PR_RANK: Record<PrStatus, number> = { open: 0, merged: 1, closed: 2 };
const prRank = (pr: PullRequest): number => (pr.status ? PR_RANK[pr.status] : 0);

// A real label (it is often just "PR"), else the branch, else the
// workspace's title. The label and branch come first because the row's faint
// line already names the workspace.
function prTitle(w: Workspace, pr: PullRequest): string {
  const label = String(pr.label || "").trim();
  return (/^pr$/i.test(label) ? "" : label) || pr.branch || displayTitle(w) || "";
}

// Every PR, open first then merged then closed. Within each state the PRs
// workspaces hold come before Jon's own that no workspace holds, newest first
// in each, so a merged or closed workspace PR can never push his open PRs out
// of the cut to MAX_PRS. Open workspace PRs still can.
const allPrs = computed((): PrEntry[] => {
  const seen = new Set<string>();
  const all = data.workspaces() ?? [];
  // A lane's placeholder is no chat (shared/anchors.ts): a PR cmux pins on it
  // is dropped, and an own PR its agent opened names no session.
  const placeholders = placeholderIds(data.groups() ?? [], new Map(all.map((w) => [w.id, w])));
  const workspaces = all.filter((w) => !placeholders.has(w.id));
  const held = workspacePrs(workspaces, seen);
  const own = ownPrs(new Map(workspaces.map((w) => [w.id, w])), seen);
  const isOwn = new Set(own.map((e) => e.key));
  return [...held, ...own].sort(
    (x, y) =>
      prRank(x.pr) - prRank(y.pr) ||
      Number(isOwn.has(x.key)) - Number(isOwn.has(y.key)) ||
      (y.pr.number ?? 0) - (x.pr.number ?? 0),
  );
});

// Every workspace's PRs, once each, noting their urls in `seen`.
function workspacePrs(workspaces: readonly Workspace[], seen: Set<string>): PrEntry[] {
  const out: PrEntry[] = [];
  for (const w of workspaces) {
    for (const pr of prsOf(w)) {
      if (!pr?.url || seen.has(pr.url)) continue;
      seen.add(pr.url);
      const summary = summaryOf(pr, checksOf(w));
      // The PR's own title when the poller saved one, as an own PR's row has.
      const title = summary?.title || prTitle(w, pr);
      out.push({
        key: pr.url,
        pr,
        title,
        summary,
        saved: fromPoller(w),
        project: savedProjectFor(w.directory, w.id),
        session: sessionOf(w),
      });
    }
  }
  return out;
}

// Jon's own open PRs not in `seen`. No workspace holds one, so the chat that
// opened it, while still open, names its session and project; else its repo does.
function ownPrs(byId: ReadonlyMap<string, Workspace>, seen: Set<string>): PrEntry[] {
  const out: PrEntry[] = [];
  for (const o of savedOwnPrs()) {
    if (seen.has(o.url)) continue;
    seen.add(o.url);
    const pr: PullRequest = { number: o.number, url: o.url, status: o.status, branch: o.branch };
    if (o.draft) pr.draft = true;
    const opener = byId.get(originOf(o.url)?.workspace ?? "");
    out.push({
      key: o.url,
      pr,
      title: o.title,
      summary: summaryOf(pr, []),
      saved: true,
      project: savedProjectFor(opener?.directory ?? o.repo, opener?.id),
      session: opener ? sessionOf(opener) : undefined,
    });
  }
  return out;
}

/** PR rows shown at most while the card is folded. */
const MAX_PRS = 5;

/** Every PR, before the cap, for the heading's count. */
export const prCount = computed((): number => allPrs().length);

// How many PRs the cap leaves out while the card is folded.
const prOver = computed((): number => moreThan(prCount(), MAX_PRS));

/** The Pull requests card's closing line, from footText. */
export const prFoot = computed((): string => footText(prOver(), isExpanded("prs")));

/** The Pull requests rows, at most MAX_PRS unless the card is open. While
 * the list overflows, a closing line follows, so no row is last. */
export const prs = computed((): Last<PrEntry>[] => {
  const all = allPrs();
  return markLastBefore(isExpanded("prs") ? all : all.slice(0, MAX_PRS), prOver());
});

/** The faint line under the Pull requests heading when the saved data is old
 * or gh is down, "gh unavailable · last checked 2h ago"; "" when fresh. */
export const prNote = computed((): string => freshness().line);

/** A PR row's chip dims while it is the poller's copy and that copy is stale. */
export const prDim = (e: Pick<PrEntry, "saved">): boolean => e.saved && prStale();

// ---- Which session a PR belongs to ------------------------------------------
// A row's faint line names the chat that holds the PR, else the one that
// opened it (report-pr.ts), with its status dot; a tap on the row opens the
// PR on GitHub.

/** "This chat" for the selected workspace, else its name, and its lead agent's dot. */
function sessionOf(w: Workspace): PrSession {
  const lead = mostActive(agentsOf(w));
  const name = w.selected ? "This chat" : displayTitle(w) || "Another chat";
  return { name, dot: dotFor(lead, w), hollow: hollowDot(lead) };
}

// ---- Made here ------------------------------------------------------------------
// Pages and docs agents published (#52), from the saved state the published
// hook writes (src/shared/published.ts). Empty without the hook: the
// section then folds into emptyNote's line at the bottom.

export interface MadeEntry {
  key: string;
  url: string;
  title: string;
  /** The project of the workspace it was made in; none when that workspace has gone. */
  project: Project;
  /** Made in the selected workspace. */
  here: boolean;
  epoch: number;
}

/** The selected workspace's own entries shown at most. */
const MADE_HERE_OWN = 5;
/** Other workspaces' entries shown at most, the latest few. */
const MADE_ELSEWHERE = 3;

function madeEntry(e: SavedPublished, dirs: Map<string, string | undefined>, here: boolean): MadeEntry {
  return {
    key: "m:" + e.url,
    url: e.url,
    // Not readable(): that is for agent chat, and would blank a title with
    // no Latin letters. The hook already checked it (isLabel).
    title: e.title.trim() || "Untitled",
    project: savedProjectFor(dirs.get(e.workspace), e.workspace),
    here,
    epoch: e.epoch,
  };
}

// The saved pages and docs still fresh, the selected workspace's id with
// them; none before the clock's first tick, when every entry would
// otherwise read as fresh.
// One computed, so the rows and the count read the same list, filtered once.
// Split once into the selected workspace's own and the rest, with the caps
// each part is cut to while the card is folded, so the rows and the count
// left out read the same cut.
const freshMade = computed(() => {
  const now = nowEpoch();
  const workspaces = data.workspaces() ?? [];
  const selected = workspaces.find((w) => w.selected)?.id;
  const fresh: SavedPublished[] = now ? savedPublished(now) : [];
  const own: SavedPublished[] = [];
  const others: SavedPublished[] = [];
  for (const e of fresh) (e.workspace === selected ? own : others).push(e);
  const shown = Math.min(own.length, MADE_HERE_OWN) + Math.min(others.length, MADE_ELSEWHERE);
  return { count: fresh.length, own, others, over: fresh.length - shown, workspaces };
});

// How many fresh pages and docs the caps leave out while the card is folded.
const madeOver = (): number => freshMade().over;

/** The Made here rows: the selected workspace's own pages and docs first,
 * newest first, then the latest few from other workspaces, or all of them
 * while the card is open. Anything past
 * seven days drops off (shared/published-age.ts); nothing shows before the
 * clock's first tick, when every entry would otherwise read as fresh. */
export const madeHere = computed((): Last<MadeEntry>[] => {
  const f = freshMade();
  // Cut to the rows shown before the project lookups, which scan every project.
  const open = isExpanded("made");
  const own = open ? f.own : f.own.slice(0, MADE_HERE_OWN);
  const others = open ? f.others : f.others.slice(0, MADE_ELSEWHERE);
  const dirs = new Map(f.workspaces.map((w) => [w.id, w.directory]));
  const rows = [...own.map((e) => madeEntry(e, dirs, true)), ...others.map((e) => madeEntry(e, dirs, false))];
  return markLastBefore(rows, madeOver());
});

/** Every fresh page and doc, before the caps, for the heading's count. */
export const madeCount = computed((): number => freshMade().count);

/** The Made here card's closing line, from footText. */
export const madeFoot = computed((): string => footText(madeOver(), isExpanded("made")));

/**
 * The one faint line at the bottom that stands in for empty sections
 * (issue #80): the selected workspace's Helpers, and Made here. Worded
 * for what is actually empty; "" when neither is. Helpers only counts
 * while the selected workspace has a live agent, since the block lives on
 * its card and a plain shell has none to run; Made here only once the
 * clock has ticked, since before that no entry counts as fresh.
 */
export const emptyNote = computed((): string => {
  const live = cur().agents.some((a) => a.status !== "ended");
  const noSubs = live && subagents().length === 0;
  const noMade = nowEpoch() > 0 && madeCount() === 0;
  if (noSubs && noMade) return "No helpers or published links yet";
  if (noSubs) return "No helpers yet";
  return noMade ? "No published links yet" : "";
});

/** Other workspaces' titles sit a step back, so this workspace's lead. */
export const madeTitleColor = (e: MadeEntry): string => (e.here ? T.text : T.secondary);

/** A Made here row's age, "3h" since it was last published. */
export const madeAge = (e: MadeEntry): string => ageSince(e.epoch);
