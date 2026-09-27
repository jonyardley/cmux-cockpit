// The agents panel's data: who is waiting, who is running, the selected
// workspace, and every PR. Pure reads of `data`, so each is testable alone.

import type { CheckState } from "../../scripts/state-config.ts";
import { byActivity, sinceOrActivity } from "../shared/activity.ts";
import { type Last, markLast } from "../shared/list.ts";
import { agentsOf } from "../shared/needs.ts";
import { type Project, projectOf } from "../shared/projects.ts";
import { checksOf, prsOf } from "../shared/prs.ts";
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

// ---- Waiting on you -----------------------------------------------------

/** Workspaces with a needs_input agent, longest-waiting first, at most 20.
 * Idle nudges and dismissed asks read as idle (src/shared/needs.ts). */
export const waiting = computed(() => {
  const out: AgentEntry[] = [];
  for (const w of data.workspaces() ?? []) {
    const a = agentsOf(w).find((x) => x.status === "needs_input");
    if (!a) continue;
    out.push({ key: "w:" + w.id, ws: w, a, project: projectOf(w.directory) });
  }
  out.sort((x, y) => sinceOrActivity(x.a) - sinceOrActivity(y.a));
  return markLast(out.slice(0, 20));
});

/** The Waiting on you card's message: the agent's words, not an echo of the prompt. */
export const waitingText = (w: Workspace): string => cardMessage(w) || "Waiting for your reply";

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

interface Run {
  owner: Agent;
  c: SubagentRun;
  i: number;
  running: boolean;
}

// Running runs first, oldest start first; then settled ones, newest end
// first, falling back on their start when cmux sends no end.
function byRun(x: Run, y: Run): number {
  if (x.running !== y.running) return x.running ? -1 : 1;
  if (x.running) return (x.c.startedEpoch ?? 0) - (y.c.startedEpoch ?? 0);
  return (y.c.endedEpoch ?? y.c.startedEpoch ?? 0) - (x.c.endedEpoch ?? x.c.startedEpoch ?? 0);
}

/** The selected workspace's subagent runs across all its agents, at most 5.
 * Settled runs stay until cmux prunes them. No clock read, so it only
 * rebuilds when the data changes; the figure is subagentFigure's. */
export const subagents = computed((): SubagentRow[] => {
  const runs = cur().agents.flatMap((owner) =>
    (owner.children ?? []).flatMap((c, i) => (c ? [{ owner, c, i, running: isRunning(c, owner) }] : [])),
  );
  return runs
    .sort(byRun)
    .slice(0, 5)
    .map(({ owner, c, i, running }) => ({
      // The index stands in for a missing id; cmux keeps children oldest first.
      key: "s:" + owner.id + ":" + (c.id ?? "#" + i),
      label: readable(c.label) || "subagent",
      running,
      startedEpoch: c.startedEpoch,
    }));
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
