// The agents panel's data: who is waiting, who is running, the selected
// workspace, and every PR. Pure reads of `data`, so each is testable alone.

import { byActivity, sinceOrActivity } from "../shared/activity.ts";
import { type Last, markLast } from "../shared/list.ts";
import { agentsOf } from "../shared/needs.ts";
import { type Project, projectOf } from "../shared/projects.ts";
import { cardMessage, readable } from "../shared/text.ts";
import { fmtAge, fmtElapsed, nowEpoch } from "../shared/time.ts";
import { displayTitle } from "../shared/titles.ts";
import { type HaloStatus, haloColor } from "../shared/ui.ts";
import { T } from "./theme.ts";

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
  agents: Agent[];
  project: Project;
}

export const current = computed((): Current | null => {
  const w = (data.workspaces() ?? []).find((x) => x.selected);
  if (!w) return null;
  const agents = agentsOf(w).sort(byActivity);
  return { ws: w, a: agents[0] ?? null, agents, project: projectOf(w.directory) };
});

/** current(), or an empty stand-in so views never branch on null. */
export const cur = (): Current => current() ?? { ws: { id: "" }, a: null, agents: [], project: projectOf("") };

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

// ---- Subagents ---------------------------------------------------------------

export interface SubagentRow {
  key: string;
  label: string;
  running: boolean;
  /** Board 1's right-hand figure: coarse elapsed while running, "done" after. */
  figure: string;
}

// Upstream always sends `running`; without it, a run with no end is live.
const isRunning = (c: SubagentRun): boolean => c.running ?? !c.endedEpoch;

// Running runs first, oldest start first; then settled ones, newest end first.
function bySubagent(a: SubagentRun, b: SubagentRun): number {
  const ra = isRunning(a);
  const rb = isRunning(b);
  if (ra !== rb) return ra ? -1 : 1;
  return ra ? (a.startedEpoch ?? 0) - (b.startedEpoch ?? 0) : (b.endedEpoch ?? 0) - (a.endedEpoch ?? 0);
}

/** The selected workspace's subagent runs across all its agents, at most 5.
 * Settled runs stay until cmux prunes them. */
export const subagents = computed((): Last<SubagentRow>[] => {
  const runs = cur().agents.flatMap((a) => (a.children ?? []).map((c) => ({ owner: a.id, c })));
  runs.sort((x, y) => bySubagent(x.c, y.c));
  return markLast(
    runs.slice(0, 5).map(({ owner, c }) => {
      const running = isRunning(c);
      return {
        key: "s:" + owner + ":" + c.id,
        label: readable(c.label) || "subagent",
        running,
        figure: running ? ageSince(c.startedEpoch) : "done",
      };
    }),
  );
});

// ---- Pull requests ----------------------------------------------------------

export interface PrEntry {
  key: string;
  pr: PullRequest;
  title: string;
}

const PR_RANK: Record<PrStatus, number> = { open: 0, merged: 1, closed: 2 };
const prRank = (pr: PullRequest): number => (pr.status ? PR_RANK[pr.status] : 3);

// A workspace's PRs: the list when the app sends one, else the single PR.
const prsOf = (w: Workspace): PullRequest[] => (w.prs?.length ? w.prs : w.pr ? [w.pr] : []);

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
