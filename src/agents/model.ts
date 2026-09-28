// The agents panel's data: the selected workspace in detail (and its
// question, when its agent needs you), who is working and who is idle, and
// every PR. Pure reads of `data`, so each is testable alone.

import type { CheckState, PublishedKind, SavedPublished } from "../../scripts/state-config.ts";
import { byActivity, sinceOrActivity } from "../shared/activity.ts";
import { prFreshness } from "../shared/freshness.ts";
import { type Last, markLast } from "../shared/list.ts";
import { agentsOf, askReason } from "../shared/needs.ts";
import { STATUS_TEXT } from "../shared/palette.ts";
import { type Project, projectOf } from "../shared/projects.ts";
import {
  checksOf,
  fromPoller,
  type PrHealth,
  type PrSummary,
  prSummary,
  prsOf,
  savedOwnPrs,
  summaryOf,
} from "../shared/prs.ts";
import { savedPublished } from "../shared/published.ts";
import { childRunning, pairLive, type SavedRun, savedRunning, savedRuns } from "../shared/subagents.ts";
import { cardMessage, readable } from "../shared/text.ts";
import { fmtAge, nowEpoch } from "../shared/time.ts";
import { displayTitle } from "../shared/titles.ts";
import { type HaloStatus, haloColor } from "../shared/ui.ts";
import { ASKING_WORD, NO_AGENT_WORD, STATUS_WORD, withAge } from "../shared/words.ts";
import { CHECK_DOT, STATUS_DOT, T } from "./theme.ts";

export interface AgentEntry {
  key: string;
  ws: Workspace;
  a: Agent;
  project: Project;
}

// Working and Idle

export const [idleOpen, setIdleOpen] = signal(false);

/** A Working or Idle row's workspace and agent. */
export type RosterEntry = AgentEntry & { kind: "run" | "idle" };

/** The row a capped list ends in: "+N more", for the rows past the cap (issue #80). */
export interface MoreRow {
  key: "more";
  kind: "more";
  count: number;
}

export type RosterRow = RosterEntry | { key: "toggle"; kind: "toggle"; count: number } | MoreRow;

// One row per workspace, from its most active agent, so a stale idle session
// beside a working one never lists the workspace as idle. The selected
// workspace is left out: This workspace already shows it. Nothing is cut
// here, so the section counts are the real totals; the rows below cap.
export const roster = computed(() => {
  const run: (AgentEntry & { kind: "run" })[] = [];
  const idle: (AgentEntry & { kind: "idle" })[] = [];
  for (const w of data.workspaces() ?? []) {
    if (w.selected) continue;
    const a = agentsOf(w).sort(byActivity)[0];
    if (!a) continue;
    const e = { ws: w, a, project: projectOf(w.directory) };
    if (a.status === "working") run.push({ ...e, key: "r:" + w.id, kind: "run" });
    else if (a.status === "idle") idle.push({ ...e, key: "i:" + w.id, kind: "idle" });
  }
  // Longest-running first: oldest sinceEpoch first.
  run.sort((x, y) => sinceOrActivity(x.a) - sinceOrActivity(y.a));
  idle.sort((x, y) => (y.a.lastActivityAt ?? 0) - (x.a.lastActivityAt ?? 0));
  return { run, idle };
});

const INLINE_IDLE = 3;
/** Working rows shown at most. */
const MAX_WORKING = 20;
/** Idle rows shown at most, expanded. */
const MAX_IDLE = 30;

/** How many of `total` rows a cap of `max` leaves out; 0 when none are. */
export const moreThan = (total: number, max: number): number => Math.max(0, total - max);

/** markLast, except that with `more` rows left out no row is last: a "+N
 * more" line follows, so the final row keeps its rule above it. */
export function markLastBefore<T>(rows: T[], more: number): Last<T>[] {
  return more > 0 ? rows.map((e) => ({ ...e, last: false })) : markLast(rows);
}

// `rows` cut to `max`, ending in a "+N more" row when any were left out.
function capped<T>(rows: readonly T[], max: number): (T | MoreRow)[] {
  const more = moreThan(rows.length, max);
  const out: (T | MoreRow)[] = rows.slice(0, max);
  if (more > 0) out.push({ key: "more", kind: "more", count: more });
  return out;
}

/** The Working section's rows, at most MAX_WORKING then "+N more"; empty
 * when nothing works, so the section is its heading and count alone. */
export const workingRows = computed((): Last<RosterRow>[] => markLast(capped<RosterRow>(roster().run, MAX_WORKING)));

/** The Idle section's rows: three inline, or when expanded up to MAX_IDLE
 * then "+N more", then the toggle; empty when nothing is idle. */
export const idleRows = computed((): Last<RosterRow>[] => {
  const { idle } = roster();
  const out: RosterRow[] = idleOpen() ? capped<RosterRow>(idle, MAX_IDLE) : idle.slice(0, INLINE_IDLE);
  const more = idle.length - INLINE_IDLE;
  if (more > 0) out.push({ key: "toggle", kind: "toggle", count: more });
  return markLast(out);
});

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
  return { ws: w, a: agents[0] ?? null, agents, inOrder, project: projectOf(w.directory) };
});

/** current(), or an empty stand-in so views never branch on null. */
export const cur = (): Current =>
  current() ?? { ws: { id: "" }, a: null, agents: [], inOrder: [], project: projectOf("") };

/** The selected workspace's open question. */
export interface Ask {
  /** The most active asking agent: Answer focuses its terminal. */
  a: Agent;
  /** The line over the buttons: "2 agents need you" when several do,
   * else why it is asking ("allow git push?"), else the agent's words, or
   * "" when there are none beyond the generic "waiting for your reply", or
   * when they may be another agent's. */
  text: string;
  /** How many agents in the workspace are asking. */
  count: number;
  /** Answer shows only with a terminal to focus: without one it would only
   * select the workspace, which is already selected. */
  canAnswer: boolean;
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
    canAnswer: !!c.a.surfaceId,
    dismissLabel: count > 1 ? "Dismiss all" : "Dismiss",
  };
});

/** The card's quiet message line; empty while the question block shows the words. */
export const cardLine = computed((): string => (currentAsk() ? "" : cardMessage(cur().ws)));

/** The card's Asked line: the last prompt Jon gave, above the agent's last
 * message (issue #80); "" when there is none worth reading. */
export const askedLine = computed((): string => readable(cur().ws.latestPrompt));

/** Idle and no agent draw a hollow ring, as the Running rows and the left sidebar do. */
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
  return isAsking(a, w) ? T.amber : (STATUS_DOT[a.status] ?? T.grey);
}

/** The card head's status colour, amber while asking. */
export function statusColor(a: Agent | null, w: Workspace = cur().ws): string {
  if (!a) return T.secondary;
  return isAsking(a, w) ? T.amberText : (STATUS_TEXT[a.status] ?? T.secondary);
}

/** Coarse age for rows, "12m" since `at`; "" without a timestamp or clock. A
 * timestamp ahead of the clock reads as "<1m", never blank. */
export function ageSince(at: number | undefined): string {
  const now = nowEpoch();
  return at && now ? fmtAge(Math.max(0, now - at)) : "";
}

// Idle and ended agents count from their last activity, the rest from the
// start of their current status.
function statusSince(a: Agent): number | undefined {
  return a.status === "idle" || a.status === "ended" ? a.lastActivityAt : (a.sinceEpoch ?? a.lastActivityAt);
}

/** Short form for agent rows, the card head's words in lower case: "working 12m", "finished 3m". */
export function statusLine(a: Agent | null, w: Workspace = cur().ws): string {
  return a ? headStatus(a, w).toLowerCase() : "";
}

/** The one age format the card shows: "<1m", "12m", counted from the
 * start of the status (idle and ended from their last activity); "" without
 * an agent or a timestamp. */
export function sinceAge(a: Agent | null): string {
  return a ? ageSince(statusSince(a)) : "";
}

/** A Working or Idle row's age, in the same format. A working row counts
 * from its start alone: its last activity resets while it works, so it
 * would read as a new run. */
export function rosterAge(e: RosterEntry): string {
  return e.kind === "run" ? ageSince(e.a.sinceEpoch) : ageSince(e.a.lastActivityAt);
}

/** The card head's status, in the words the cockpit uses: "Working 14m", "Asking 2m", "Finished 3m", "No agent". */
export function headStatus(a: Agent | null, w: Workspace = cur().ws): string {
  if (!a) return NO_AGENT_WORD;
  const word = isAsking(a, w) ? ASKING_WORD : (STATUS_WORD[a.status] ?? a.status);
  return withAge(word, sinceAge(a));
}

// The card's details

/** The Branch detail: the branch, then "uncommitted changes" when dirty.
 * cmux sends no file count, so it never says how many. */
export const branchDetail = computed((): string => {
  const w = cur().ws;
  return [w.branch, w.dirty ? "uncommitted changes" : ""].filter(Boolean).join(" · ");
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

/** Whether any of Branch, Ports or PR shows, so an empty block costs no gap. */
export const hasDetails = computed((): boolean => !!branchDetail() || portChips().length > 0 || !!currentPr());

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
}

// A run ranked for sorting and display, whichever source it came from.
interface Ranked {
  key: string;
  label: string;
  running: boolean;
  startedEpoch: number | undefined;
  endedEpoch: number | undefined;
}

// Running runs first, oldest start first; then settled ones, newest end
// first, falling back on their start when cmux sends no end.
function byRun(x: Ranked, y: Ranked): number {
  if (x.running !== y.running) return x.running ? -1 : 1;
  if (x.running) return (x.startedEpoch ?? 0) - (y.startedEpoch ?? 0);
  return (y.endedEpoch ?? y.startedEpoch ?? 0) - (x.endedEpoch ?? x.startedEpoch ?? 0);
}

function toRow(r: Ranked): SubagentRow {
  return { key: r.key, label: r.label, running: r.running, startedEpoch: r.startedEpoch, endedEpoch: r.endedEpoch };
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
        },
      ];
    }),
  );
}

// A saved run's owner is the workspace agent whose id matches its session,
// when there is one (unconfirmed whether cmux agent ids are Claude session
// ids); otherwise the run belongs to the workspace as a whole. savedRunning
// says whether it is live, so a closed session never ticks on.
function savedRanked(run: SavedRun, agents: Agent[]): Ranked {
  const owner = agents.find((a) => a.id === run.session);
  return {
    key: "s:" + (owner?.id ?? "ws") + ":" + run.id,
    label: readable(run.label) || "subagent",
    running: savedRunning(run, agents),
    startedEpoch: run.startedEpoch,
    endedEpoch: run.endedEpoch,
  };
}

// cmux's children, plus the live saved runs cmux has already pruned.
function withSaved(wsId: string, agents: Agent[]): Ranked[] {
  const { vouched, unclaimed } = pairLive(wsId, agents);
  return [...childRanked(agents, vouched), ...unclaimed.map((r) => savedRanked(r, agents))];
}

/** The selected workspace's subagent runs, at most 5: cmux's own `children`
 * while any agent carries some, corrected by the saved runs still live
 * (pairLive, #83), else the saved runs from config/state.json (issue #6). Settled runs stay until their source drops them. No clock
 * read, so it only rebuilds when the data changes; the figure is
 * subagentFigure's. */
export const subagents = computed((): SubagentRow[] => {
  const { ws, agents } = cur();
  // cmux can send a children array full of holes (agentRows survives the
  // same); only a real, truthy child should count as cmux having its own
  // data, else an all-holes array would show nothing rather than fall back.
  const ranked = agents.some((a) => (a.children ?? []).some((c) => c))
    ? withSaved(ws.id, agents)
    : savedRuns(ws.id).map((r) => savedRanked(r, agents));
  return ranked.sort(byRun).slice(0, 5).map(toRow);
});

/** Board 1's right-hand figure, kept short so the run's name is not the
 * one cut: coarse elapsed while running ("4m"; "running" without a start
 * or clock), "done" once settled. */
export function subagentFigure(s: SubagentRow): string {
  if (s.running) return ageSince(s.startedEpoch) || "running";
  return "done";
}

/** A finished run's label dims, so the live ones stand out. */
export const subagentLabelColor = (s: SubagentRow): string => (s.running ? T.text : T.tertiary);

// A running run reads as a working agent, a settled one as ended.
const runStatus = (s: SubagentRow): AgentStatus => (s.running ? "working" : "ended");

export const subagentDot = (s: SubagentRow): string => STATUS_DOT[runStatus(s)];

export const subagentHalo = (s: SubagentRow): string => haloColor(runStatus(s), HALO_COLOR);

// Checks

export interface CheckRow {
  key: string;
  name: string;
  state: CheckState;
}

/** The selected workspace's CI checks, as the poller last saved them. */
export const checks = computed((): CheckRow[] =>
  // Two checks can share a name (one per workflow), so the index keeps them apart.
  checksOf(cur().ws).map((c, i) => ({ key: "c:" + i + ":" + c.name, name: c.name, state: c.state })),
);

/** Board 1's "3 / 5": passed over total. */
export function checksFigure(rows: readonly CheckRow[]): string {
  return rows.filter((c) => c.state === "pass").length + " / " + rows.length;
}

const CHECK_WORD: Record<CheckState, string> = { pass: "passed", fail: "failed", pending: "running" };

export const checkWord = (c: CheckRow): string => CHECK_WORD[c.state];

export const checkDot = (c: CheckRow): string => CHECK_DOT[c.state];

// ---- Pull requests ----------------------------------------------------------

export interface PrEntry {
  key: string;
  pr: PullRequest;
  title: string;
  /** The PR as the cards read it (shared/prs.ts), so the chip says the same on both sides. */
  summary: PrSummary | undefined;
  /** The poller's saved copy rather than cmux's own, so it can go stale. */
  saved: boolean;
}

/**
 * What a PR row's chip says: the PR's worst state as its card says it
 * ("1 failing", "conflicts", "draft · running", "ready", "open", "merged"),
 * or for a PR with no number, "draft" for an open draft, else its status.
 * Stale rides inside the chip (see prRow).
 */
export function prChipText(e: Pick<PrEntry, "pr" | "summary">): string {
  const { pr, summary } = e;
  const word = summary ? summary.state : pr.status === "open" && pr.draft ? "draft" : pr.status;
  return [word, pr.stale ? "stale" : undefined].filter(Boolean).join(" · ");
}

/** A PR row chip's health and draft flag, for its colours. */
export function prChipHealth(e: Pick<PrEntry, "pr" | "summary">): { health: PrHealth; draft: boolean } {
  return e.summary
    ? { health: e.summary.health, draft: e.summary.draft }
    : { health: "quiet", draft: e.pr.status === "open" && e.pr.draft === true };
}

const PR_RANK: Record<PrStatus, number> = { open: 0, merged: 1, closed: 2 };
const prRank = (pr: PullRequest): number => (pr.status ? PR_RANK[pr.status] : 3);
const byRankThenNewest = (x: PrEntry, y: PrEntry): number =>
  prRank(x.pr) - prRank(y.pr) || (y.pr.number ?? 0) - (x.pr.number ?? 0);

// The workspace's title, else a real label (it is often just "PR"), else the branch.
function prTitle(w: Workspace, pr: PullRequest): string {
  const label = String(pr.label || "").trim();
  return displayTitle(w) || (/^pr$/i.test(label) ? "" : label) || pr.branch || "";
}

// Every PR across workspaces, open first then merged then closed, newest
// first within each; then Jon's own open PRs no workspace holds, newest
// first. Workspace PRs rank first, so a long list of his own PRs in a busy
// repo can never push one out of the cut to MAX_PRS.
const allPrs = computed((): PrEntry[] => {
  const seen = new Set<string>();
  const out: PrEntry[] = [];
  for (const w of data.workspaces() ?? []) {
    for (const pr of prsOf(w)) {
      if (!pr?.url || seen.has(pr.url)) continue;
      seen.add(pr.url);
      const summary = summaryOf(pr, checksOf(w));
      // The PR's own title when the poller saved one, as an own PR's row has.
      out.push({ key: pr.url, pr, title: summary?.title || prTitle(w, pr), summary, saved: fromPoller(w) });
    }
  }
  out.sort(byRankThenNewest);
  const own: PrEntry[] = [];
  for (const o of savedOwnPrs()) {
    if (seen.has(o.url)) continue;
    seen.add(o.url);
    const pr: PullRequest = { number: o.number, url: o.url, status: o.status, branch: o.branch };
    if (o.draft) pr.draft = true;
    own.push({ key: o.url, pr, title: o.title, summary: summaryOf(pr, []), saved: true });
  }
  own.sort(byRankThenNewest);
  out.push(...own);
  return out;
});

/** PR rows shown at most. */
const MAX_PRS = 30;

/** Every PR, before the cap, for the heading's count. */
export const prCount = computed((): number => allPrs().length);

/** How many PRs the cap leaves out, for the "+N more" line. */
export const prMore = computed((): number => moreThan(prCount(), MAX_PRS));

/** The Pull requests rows, at most MAX_PRS. */
export const prs = computed((): Last<PrEntry>[] => markLastBefore(allPrs().slice(0, MAX_PRS), prMore()));

/** The faint line under the Pull requests heading when the saved data is old
 * or gh is down, "gh unavailable · last checked 2h ago"; "" when fresh. */
export const prNote = computed((): string => freshness().line);

/** A PR row's chip dims while it is the poller's copy and that copy is stale. */
export const prDim = (e: Pick<PrEntry, "saved">): boolean => e.saved && prStale();

// ---- Made here ------------------------------------------------------------------
// Pages and docs agents published (#52), from the saved state the published
// hook writes (src/shared/published.ts). Empty without the hook: the
// section then folds into emptyNote's line at the bottom.

export interface MadeEntry {
  key: string;
  url: string;
  title: string;
  kind: PublishedKind;
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
    kind: e.kind,
    project: projectOf(dirs.get(e.workspace)),
    here,
    epoch: e.epoch,
  };
}

// The saved pages and docs still fresh, the selected workspace's id with
// them; none before the clock's first tick, when every entry would
// otherwise read as fresh.
// One computed, so the rows and the count read the same list, filtered once.
const freshMade = computed((): { fresh: SavedPublished[]; workspaces: Workspace[]; selected: string | undefined } => {
  const now = nowEpoch();
  const workspaces = data.workspaces() ?? [];
  const selected = workspaces.find((w) => w.selected)?.id;
  return { fresh: now ? savedPublished(now) : [], workspaces, selected };
});

/** The Made here rows: the selected workspace's own pages and docs first,
 * newest first, then the latest few from other workspaces. Anything past
 * seven days drops off (shared/published-age.ts); nothing shows before the
 * clock's first tick, when every entry would otherwise read as fresh. */
export const madeHere = computed((): Last<MadeEntry>[] => {
  const { fresh, workspaces, selected } = freshMade();
  // Cut to the rows shown before the project lookups, which scan every project.
  const own = fresh.filter((e) => e.workspace === selected).slice(0, MADE_HERE_OWN);
  const others = fresh.filter((e) => e.workspace !== selected).slice(0, MADE_ELSEWHERE);
  const dirs = new Map(workspaces.map((w) => [w.id, w.directory]));
  const rows = [...own.map((e) => madeEntry(e, dirs, true)), ...others.map((e) => madeEntry(e, dirs, false))];
  return markLastBefore(rows, moreThan(fresh.length, rows.length));
});

/** Every fresh page and doc, before the caps, for the heading's count. */
export const madeCount = computed((): number => freshMade().fresh.length);

/** How many fresh pages and docs the caps leave out, for the "+N more" line. */
export const madeMore = computed((): number => moreThan(madeCount(), madeHere().length));

/**
 * The one faint line at the bottom that stands in for empty sections
 * (issue #80): the selected workspace's Subagents, and Made here. Worded
 * for what is actually empty; "" when neither is. Subagents only counts
 * while the selected workspace has a live agent, since the block lives on
 * its card and a plain shell has none to run; Made here only once the
 * clock has ticked, since before that no entry counts as fresh.
 */
export const emptyNote = computed((): string => {
  const live = cur().agents.some((a) => a.status !== "ended");
  const noSubs = live && subagents().length === 0;
  const noMade = nowEpoch() > 0 && madeCount() === 0;
  if (noSubs && noMade) return "No subagents or published links yet";
  if (noSubs) return "No subagents yet";
  return noMade ? "No published links yet" : "";
});

const MADE_ICON: Record<PublishedKind, string> = { page: "macwindow", doc: "doc.text" };

/** A Made here row's leading symbol: a window for a page, a sheet for a doc. */
export const madeIcon = (e: MadeEntry): string => MADE_ICON[e.kind];

/** Other workspaces' titles sit a step back, so this workspace's lead. */
export const madeTitleColor = (e: MadeEntry): string => (e.here ? T.text : T.secondary);

/** A Made here row's age, "3h" since it was last published. */
export const madeAge = (e: MadeEntry): string => ageSince(e.epoch);
