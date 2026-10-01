// Next and the Needs you strip's way back to a card: where a session came from, and revealing it.

import { finishedAt } from "../shared/time.ts";
import { isProjectCollapsed, projectKey, projectOfWorkspace, toggleProject } from "./by-project.ts";
import { laneByKey } from "./lanes.ts";
import { allWorkspaces, chooseMode, isCollapsed, laneAnchorIds, laneOf, toggleLane, wsById } from "./model.ts";
import { isSelected, mode, selectWorkspace, tick } from "./state.ts";
import { readyAgent } from "./status.ts";
import { needsList } from "./strip.ts";

/** Where a session in Needs you came from: its lane and marker, or its project group in Projects view. */
export function originOf(w: Workspace | undefined): { name: string; color: string } {
  if (!w) return { name: "", color: "clear" };
  // A lane's generated anchor is in no project group: it names its lane in both views.
  if (mode() === "projects" && !laneAnchorIds().has(w.id)) {
    const p = projectOfWorkspace(w);
    return { name: p.name, color: p.color };
  }
  const lane = laneByKey(laneOf(w));
  return { name: lane.name, color: lane.color };
}

// Next (issue #74)

/** What the Next button walks through: needs you, then Ready, each longest-waiting first. */
export const nextQueue = computed((): Workspace[] => [...needsList(), ...readyByFinish()]);

// Ready workspaces, longest-finished first, dated as the Ready card dates
// them (issue #98). Each one's finish is read once, not per comparison.
function readyByFinish(): Workspace[] {
  const ready: { w: Workspace; at: number }[] = [];
  for (const w of allWorkspaces()) {
    const a = readyAgent(w);
    if (a) ready.push({ w, at: finishedAt(a) });
  }
  return ready.sort((x, y) => x.at - y.at).map((e) => e.w);
}

// The last workspace Next opened, and the one after it then. Opening a
// Ready workspace clears its Ready state, so it drops out of the queue:
// while Jon is still on it, the next press goes to the one that followed
// it, or to the same place if that one has gone too. Forgotten once he
// moves off it. A plain let: jumpNext bumps.
let lastJump: { id: string; index: number; afterId: string | null } | null = null;

// Each press moves on from where Jon is: after the selected workspace when
// it is in the queue; after the one Next last opened when that has dropped
// out and he is still on it; else from the top.
function nextIndex(queue: readonly Workspace[]): number {
  tick();
  const on = queue.findIndex((w) => isSelected(w));
  if (on >= 0) return (on + 1) % queue.length;
  if (lastJump && !isSelected(wsById(lastJump.id))) lastJump = null;
  if (!lastJump) return 0;
  const { afterId, index } = lastJump;
  const after = queue.findIndex((w) => w.id === afterId);
  return after >= 0 ? after : index % queue.length;
}

export interface NextStep {
  target: Workspace;
  /** 1-based, for "1 of 6". */
  position: number;
  total: number;
}

/** Where the next press goes, or null when nothing needs Jon or is Ready. */
export const nextStep = computed((): NextStep | null => {
  const queue = nextQueue();
  if (!queue.length) return null;
  const i = nextIndex(queue);
  const target = queue[i];
  // Nothing to move on to when the only one waiting is the one Jon is on.
  if (!target || isSelected(target)) return null;
  return { target, position: i + 1, total: queue.length };
});

/** The Next button: selects the next workspace in the queue. */
export function jumpNext(): void {
  const step = nextStep();
  if (!step) return;
  const queue = nextQueue();
  lastJump = { id: step.target.id, index: step.position - 1, afterId: queue[step.position]?.id ?? null };
  revealWorkspace(step.target);
}

/**
 * Selects a workspace from Needs you or Next, first unfolding what hides its
 * card in the chosen view: its lane in All, its project in Projects. One the
 * strip lists is unfolded too, so its card is in view when it comes back
 * after an answer. A lane's generated anchor has no card; its status sits on
 * the lane header, which shows folded or not, but only in All, so Projects
 * switches to All for it.
 */
export function revealWorkspace(w: Workspace | undefined): void {
  if (!w) return;
  if (!laneAnchorIds().has(w.id)) unfoldCardOf(w);
  else chooseMode("all");
  selectWorkspace(w.id);
}

function unfoldCardOf(w: Workspace): void {
  if (mode() === "all") {
    const lane = laneByKey(laneOf(w));
    if (isCollapsed(lane)) toggleLane(lane);
    return;
  }
  const k = projectKey(w);
  if (isProjectCollapsed(k)) toggleProject(k);
}
