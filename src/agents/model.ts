// The agents panel's data: the selected workspace (and its question, when
// its agent needs you), who is running, and every PR. Pure reads of `data`, so each is testable alone.

import type { CheckState } from "../../scripts/state-config.ts";
import { byActivity, sinceOrActivity } from "../shared/activity.ts";
import { type Last, markLast } from "../shared/list.ts";
import { agentsOf } from "../shared/needs.ts";
import { type Project, projectOf } from "../shared/projects.ts";
import { checksOf, prsOf } from "../shared/prs.ts";
import { type SavedRun, savedRuns } from "../shared/subagents.ts";
import { cardMessage, readable } from "../shared/text.ts";
import { fmtAge, fmtElapsed, nowEpoch } from "../shared/time.ts";
import { displayTitle } from "../shared/titles.ts";
import { type HaloStatus, haloColor } from "../shared/ui.ts";
import { CHECK_DOT, STATUS_DOT, T } from "./theme.ts";

export interface AgentEntry {
  key: string;
  ws: Workspace;
  a: Agent;
  project: Project;
}

// ---- Running --------------------------------------------------------------

export const [idleOpen, setIdleOpen] = signal(false);

export type RosterRow =
  | (AgentEntry & { kind: "run" | "idle" })
  | { key: "toggle"; kind: "toggle"; count: number }
  | { key: "idle-heading"; kind: "idle-heading" }
  | { key: "empty"; kind: "empty" };

// One row per workspace, from its most active agent, so a stale idle session
// beside a working one never lists the workspace as idle. The selected
// workspace is left out: This workspace already shows it.
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
  return { run: run.slice(0, 20), idle: idle.slice(0, 30) };
});

const INLINE_IDLE = 3;

// Panel rows: running (or a "Nothing running" row when nothing is working),
// then an "Idle" subheading and the idle rows (else "Nothing running" reads
// as a contradiction sat right above them), all of them when expanded, then
// the idle toggle.
export const runningRows = computed(() => {
  const { run, idle } = roster();
  const out: RosterRow[] = run.length ? [...run] : [{ key: "empty", kind: "empty" }];
  const shown = idleOpen() ? idle : idle.slice(0, INLINE_IDLE);
  if (shown.length) out.push({ key: "idle-heading", kind: "idle-heading" });
  out.push(...shown);
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
  /** The line over the buttons: "2 agents are asking" when several ask,
   * else the agent's words, or "" when there are none beyond the generic
   * "waiting for your reply", or when they may be another agent's. */
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
  if (count > 1) return `${count} agents are asking`;
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

/** Idle and no agent draw a hollow ring, as the Running rows and the left sidebar do. */
export const hollowDot = (a: Agent | null): boolean => !a || a.status === "idle";

// The halo colour for each of shared/ui.ts's two haloed statuses; every
// other status reads "clear" (haloColor falls back to it via haloStatus),
// matching the left sidebar's status.ts.
const HALO_COLOR: Record<HaloStatus, string> = { working: T.blueHalo, needs_input: T.clayHalo };

/** Board 1's soft halo round a live dot: working and needs only, as the left sidebar rings them. */
export const haloFor = (a: Agent | null): string => haloColor(a?.status, HALO_COLOR);

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

const STATUS_WORD: Record<AgentStatus, string> = {
  needs_input: "needs you",
  working: "working",
  idle: "idle",
  ended: "ended",
};

/** Short form for agent rows, with the rows' coarse age: "working 12m". */
export function statusLine(a: Agent | null): string {
  if (!a) return "";
  const age = ageSince(statusSince(a));
  return (STATUS_WORD[a.status] ?? a.status) + (age ? " " + age : "");
}

/** Sentence form for the card, with the finer elapsed time: "Working for 12m", "Ended 3m ago". */
export function statusPhrase(a: Agent | null): string {
  if (!a) return "No agent";
  const since = statusSince(a);
  const age = since ? fmtElapsed(nowEpoch() - since) : "";
  if (a.status === "ended") return age ? "Ended " + age + " ago" : "Ended";
  const word = { needs_input: "Needs you", working: "Working", idle: "Idle" }[a.status] ?? a.status;
  return age ? word + " for " + age : word;
}

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
}

// Upstream always sends `running`; without it, a run with no end is live. A
// run under an ended session is over whatever it says, so an interrupted
// subagent never ticks on as running.
const isRunning = (c: SubagentRun, owner: Agent): boolean => owner.status !== "ended" && (c.running ?? !c.endedEpoch);

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
  return { key: r.key, label: r.label, running: r.running, startedEpoch: r.startedEpoch };
}

// cmux's own children, ranked; empty when every agent has none, so a
// workspace with no live cmux data falls through to the saved runs.
function childRanked(agents: Agent[]): Ranked[] {
  return agents.flatMap((owner) =>
    (owner.children ?? []).flatMap((c, i) =>
      c
        ? [
            {
              // The index stands in for a missing id; cmux keeps children oldest first.
              key: "s:" + owner.id + ":" + (c.id ?? "#" + i),
              label: readable(c.label) || "subagent",
              running: isRunning(c, owner),
              startedEpoch: c.startedEpoch,
              endedEpoch: c.endedEpoch,
            },
          ]
        : [],
    ),
  );
}

// A saved run's owner is the workspace agent whose id matches its session,
// when there is one (unconfirmed whether cmux agent ids are Claude session
// ids); otherwise the run belongs to the workspace as a whole, and only
// counts as running while it has no end and the workspace still has a live
// agent, so a closed session never ticks on.
function savedRanked(run: SavedRun, agents: Agent[]): Ranked {
  const owner = agents.find((a) => a.id === run.session);
  const running =
    run.endedEpoch === undefined && (owner ? owner.status !== "ended" : agents.some((a) => a.status !== "ended"));
  return {
    key: "s:" + (owner?.id ?? "ws") + ":" + run.id,
    label: readable(run.label) || "subagent",
    running,
    startedEpoch: run.startedEpoch,
    endedEpoch: run.endedEpoch,
  };
}

/** The selected workspace's subagent runs, at most 5: cmux's own `children`
 * while any agent carries some, else the saved runs from config/state.json
 * (issue #6). Settled runs stay until their source drops them. No clock
 * read, so it only rebuilds when the data changes; the figure is
 * subagentFigure's. */
export const subagents = computed((): SubagentRow[] => {
  const { ws, agents } = cur();
  // cmux can send a children array full of holes (agentRows survives the
  // same); only a real, truthy child should count as cmux having its own
  // data, else an all-holes array would show nothing rather than fall back.
  const ranked = agents.some((a) => (a.children ?? []).some((c) => c))
    ? childRanked(agents)
    : savedRuns(ws.id).map((r) => savedRanked(r, agents));
  return ranked.sort(byRun).slice(0, 5).map(toRow);
});

/** Board 1's right-hand figure: coarse elapsed while running ("running"
 * without a start or clock), "done" once settled. */
export function subagentFigure(s: SubagentRow): string {
  return s.running ? ageSince(s.startedEpoch) || "running" : "done";
}

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
}

/**
 * What a PR row's chip says: "draft" for an open draft, since "open" reads as
 * ready for review, else the status; a merged or closed PR says its status
 * whatever its draft flag. Stale rides inside the chip (see prRow).
 */
export function prChipText(pr: PullRequest): string {
  const word = pr.status === "open" && pr.draft ? "draft" : pr.status;
  return [word, pr.stale ? "stale" : undefined].filter(Boolean).join(" · ");
}

const PR_RANK: Record<PrStatus, number> = { open: 0, merged: 1, closed: 2 };
const prRank = (pr: PullRequest): number => (pr.status ? PR_RANK[pr.status] : 3);

// The workspace's title, else a real label (it is often just "PR"), else the branch.
function prTitle(w: Workspace, pr: PullRequest): string {
  const label = String(pr.label || "").trim();
  return displayTitle(w) || (/^pr$/i.test(label) ? "" : label) || pr.branch || "";
}

// Every PR across workspaces, de-duplicated by url, open first then merged
// then closed, newest first within each.
export const prs = computed(() => {
  const seen = new Set<string>();
  const out: PrEntry[] = [];
  for (const w of data.workspaces() ?? []) {
    for (const pr of prsOf(w)) {
      if (!pr?.url || seen.has(pr.url)) continue;
      seen.add(pr.url);
      out.push({ key: pr.url, pr, title: prTitle(w, pr) });
    }
  }
  out.sort((x, y) => prRank(x.pr) - prRank(y.pr) || (y.pr.number ?? 0) - (x.pr.number ?? 0));
  return markLast(out.slice(0, 30));
});
