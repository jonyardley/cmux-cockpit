// The selected workspace's agents and the subagents (Helpers) they run.
// Pure reads of `data`, so each is testable alone.

import { type Last, markLast } from "../shared/list.ts";
import { SAVED_STATE } from "../shared/persist.ts";
import { childRunning, pairLive, type SavedRun, savedRunning, savedRuns } from "../shared/subagents.ts";
import { readable } from "../shared/text.ts";
import { ageSince } from "../shared/time.ts";
import { countTint, type PillColors } from "../shared/ui.ts";
import { moreThan } from "./lists.ts";

import { cur } from "./model.ts";

// ---- This workspace's agent list -------------------------------------------

export interface AgentRow {
  key: string;
  a: Agent;
  label: string;
}

const fallbackLabel = (a: Agent): string => a.name || a.kind || "agent";

/** The name scripts/hooks/report-rename.ts saved for the agent's session, or "" when none. */
function savedName(a: Agent): string {
  // A test can seed __STATE__ from before this map existed, as savedRuns notes.
  const names = SAVED_STATE.names;
  return names && Object.hasOwn(names, a.id) ? readable(names[a.id]?.name) : "";
}

// The saved session name wins, then cmux's title (its first message, when
// it could read one); otherwise agents sharing a fallback label are numbered
// in cmux's own order, ended ones included, so a number holds still as
// activity changes and as earlier agents end.
function labelsFor(inOrder: Agent[]): Map<string, string> {
  const plain = inOrder.map((a) => ({ a, title: savedName(a) || readable(a.title), base: fallbackLabel(a) }));
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
