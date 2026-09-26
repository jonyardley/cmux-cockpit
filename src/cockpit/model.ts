// Workspaces as the cockpit sees them: which lane each is in, selection and
// collapse, and the row lists each mode renders.
//
// Optimistic overrides flip locally the same frame, then clear once the data
// agrees or after OVERRIDE_SECS (so a normalised result from the app wins).

import { PROJECTS, type Project, projectId, projectOf } from "../shared/projects.ts";
import { nowEpoch } from "../shared/time.ts";
import { LANES, type Lane, type LaneKey, laneByKey } from "./lanes.ts";
import {
  bump,
  collapsedProjects,
  mode,
  projectsMode,
  setCollapsedProjects,
  setUnsortedCollapsed,
  tick,
  unsortedCollapsed,
} from "./state.ts";
import { sinceOf, statusOf } from "./status.ts";

const OVERRIDE_SECS = 4;

// --- groups and lanes ---------------------------------------------------------------

export const groups = (): WorkspaceGroup[] => data.groups() ?? [];

export const groupForLane = (lane: Lane): WorkspaceGroup | null =>
  lane.key === "unsorted" ? null : (groups().find((g) => g.name === lane.name) ?? null);

// Each lane group's anchor is a generated workspace, not a real card.
export function laneAnchorIds(): Set<string> {
  const out = new Set<string>();
  for (const lane of LANES) {
    const g = groupForLane(lane);
    if (g?.anchorId) out.add(g.anchorId);
  }
  return out;
}

export function actualLaneOf(w: Workspace | undefined): LaneKey {
  if (!w?.group) return "unsorted";
  for (const lane of LANES) {
    const g = groupForLane(lane);
    if (g && g.id === w.group) return lane.key;
  }
  return "unsorted";
}

const laneOverride = new Map<string, { lane: LaneKey; at: number }>(); // wsId -> pending move

export function laneOf(w: Workspace): LaneKey {
  tick();
  const actual = actualLaneOf(w);
  const o = laneOverride.get(w.id);
  if (o) {
    if (o.lane === actual || nowEpoch() - o.at > OVERRIDE_SECS) laneOverride.delete(w.id);
    else return o.lane;
  }
  return actual;
}

// Move a workspace into a lane (no reorder). Used by the context menu and drops.
export function moveToLane(w: Workspace | undefined, laneKey: LaneKey): void {
  if (!w || actualLaneOf(w) === laneKey) return;
  if (laneKey === "unsorted") {
    cmux("workspace.group.remove", { workspace_id: w.id });
  } else {
    const g = groupForLane(laneByKey(laneKey));
    if (!g) return;
    cmux("workspace.group.add", { group_id: g.id, workspace_id: w.id });
  }
  laneOverride.set(w.id, { lane: laneKey, at: nowEpoch() });
  bump();
}

// --- order ---------------------------------------------------------------------------

let orderOverride: { ids: string[]; at: number } | null = null;

/** Records a reorder the app has not reflected yet. */
export function overrideOrder(ids: string[]): void {
  orderOverride = { ids, at: nowEpoch() };
  bump();
}

function allWorkspaces(): Workspace[] {
  tick();
  let ws = data.workspaces() ?? [];
  if (orderOverride) {
    const ids = orderOverride.ids.filter((id) => ws.some((w) => w.id === id));
    if (ws.map((w) => w.id).join(",") === ids.join(",") || nowEpoch() - orderOverride.at > OVERRIDE_SECS) {
      orderOverride = null;
    } else {
      const rank = new Map(ids.map((id, i) => [id, i]));
      ws = [...ws].sort((a, b) => (rank.get(a.id) ?? 1e9) - (rank.get(b.id) ?? 1e9));
    }
  }
  return ws;
}

/** Real cards: every workspace except the generated lane anchors. */
export function cardWorkspaces(): Workspace[] {
  const anchors = laneAnchorIds();
  return allWorkspaces().filter((w) => !anchors.has(w.id));
}

export const wsById = (id: string): Workspace | undefined => (data.workspaces() ?? []).find((w) => w.id === id);

// --- selection -----------------------------------------------------------------------

let selectOverride: string | null = null;

export function isSelected(w: Workspace | undefined): boolean {
  tick();
  if (!w) return false;
  if (selectOverride) {
    if (data.selectedId() === selectOverride) selectOverride = null;
    else return w.id === selectOverride;
  }
  return !!w.selected;
}

export function selectWorkspace(id: string | undefined): void {
  if (!id) return;
  selectOverride = id;
  bump();
  cmux("workspace.select", { workspace_id: id });
}

// --- lane collapse -------------------------------------------------------------------

const collapseOverride = new Map<string, boolean>(); // groupId -> collapsed
const touchedLanes = new Set<LaneKey>();

export function isCollapsed(lane: Lane): boolean {
  tick();
  if (lane.key === "unsorted") return unsortedCollapsed();
  const g = groupForLane(lane);
  if (!g) return false;
  const v = collapseOverride.get(g.id);
  if (v !== undefined) {
    if (v === g.collapsed) collapseOverride.delete(g.id);
    else return v;
  }
  if (lane.startsCollapsed && !touchedLanes.has(lane.key)) return true;
  return !!g.collapsed;
}

export function toggleLane(lane: Lane): void {
  const next = !isCollapsed(lane);
  touchedLanes.add(lane.key);
  if (lane.key === "unsorted") {
    setUnsortedCollapsed(next);
    return;
  }
  const g = groupForLane(lane);
  if (!g) return;
  collapseOverride.set(g.id, next);
  bump();
  cmux(next ? "workspace.group.collapse" : "workspace.group.expand", { group_id: g.id });
}

// --- All mode: one flat list of lane headers and cards --------------------------------

export type LaneEntry =
  | { kind: "header"; id: string; lane: LaneKey }
  | { kind: "ws"; id: string; wsId: string; lane: LaneKey };

const laneEntries = computed(() => {
  const cards = cardWorkspaces();
  const entries: LaneEntry[] = [];
  for (const lane of LANES) {
    entries.push({ kind: "header", id: "h:" + lane.key, lane: lane.key });
    if (isCollapsed(lane)) continue;
    for (const w of cards) {
      if (laneOf(w) === lane.key) entries.push({ kind: "ws", id: w.id + "@" + lane.key, wsId: w.id, lane: lane.key });
    }
  }
  return entries;
});

// The lanes' Reorderable goes empty in Projects mode, so a drag there can
// never resolve to a lane move.
export const flatEntries = (): LaneEntry[] => (mode() === "all" ? laneEntries() : []);

export const laneCount = (laneKey: LaneKey) => cardWorkspaces().filter((w) => laneOf(w) === laneKey).length;

// --- Projects mode ---------------------------------------------------------------------
// PROJECTS order, then Other; empty projects are skipped. Grouped by project,
// not by match, so a project with several paths is one group. Collapse is
// local only: projects are not cmux groups.

const OTHER: Project = { match: "other", name: "Other", color: "#A09E95", icon: "terminal" };

// Session-only "Move to project" override (issue #8): no cmux field holds
// project membership, so this map is the whole persistence story, and it is
// gone on reload. Consulted before the path match, the way laneOf consults
// laneOverride, but with no decay: nothing in cmux ever supersedes it.
const projectOverride = new Map<string, string>(); // wsId -> project key

export const projectKey = (w: Workspace): string => {
  tick();
  const o = projectOverride.get(w.id);
  if (o) return o;
  const p = projectOf(w.directory);
  return PROJECTS.includes(p) ? projectId(p) : projectId(OTHER);
};

/** Move a workspace to a project for the rest of this session. Used by the context menu. */
export function moveToProject(w: Workspace | undefined, key: string): void {
  if (!w || !PROJECTS.some((p) => projectId(p) === key)) return;
  projectOverride.set(w.id, key);
  bump();
}

/** Drop the override, so the workspace falls back to its path match. */
export function clearProjectOverride(w: Workspace | undefined): void {
  if (!w) return;
  projectOverride.delete(w.id);
  bump();
}

export const hasProjectOverride = (w: Workspace | undefined): boolean => {
  tick();
  return !!w && projectOverride.has(w.id);
};

export const projectByKey = (k: string): Project => PROJECTS.find((p) => projectId(p) === k) ?? OTHER;
export const isProjectCollapsed = (k: string) => collapsedProjects().includes(k);
export const toggleProject = (k: string) =>
  setCollapsedProjects(
    isProjectCollapsed(k) ? collapsedProjects().filter((x) => x !== k) : [...collapsedProjects(), k],
  );
export const projectCount = (k: string) => cardWorkspaces().filter((w) => projectKey(w) === k).length;

export type ProjectEntry = { kind: "header"; id: string; project: string } | { kind: "ws"; id: string; wsId: string };

export const projectEntries = computed(() => {
  if (!projectsMode()) return [];
  const cards = cardWorkspaces();
  const entries: ProjectEntry[] = [];
  for (const p of [...PROJECTS, OTHER]) {
    const k = projectId(p);
    const rows = cards.filter((w) => projectKey(w) === k);
    if (!rows.length) continue;
    entries.push({ kind: "header", id: "p:" + k, project: k });
    if (isProjectCollapsed(k)) continue;
    // One row shape in Projects mode, so the lane no longer rides in the id.
    for (const w of rows) entries.push({ kind: "ws", id: w.id + "@p", wsId: w.id });
  }
  return entries;
});

// --- Needs you ---------------------------------------------------------------------------

/** Workspaces waiting on Jon, longest-waiting first. */
export const needsList = computed(() =>
  cardWorkspaces()
    .filter((w) => statusOf(w) === "needs_input")
    .sort((a, b) => sinceOf(a) - sinceOf(b)),
);
