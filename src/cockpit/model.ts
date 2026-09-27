// Workspaces as the cockpit sees them: which lane each is in, selection and
// collapse, and the row lists each mode renders.
//
// Optimistic overrides flip locally the same frame, then clear once the data
// agrees or after OVERRIDE_SECS (so a normalised result from the app wins).

import type { ProjectSpec } from "../../scripts/state-config.ts";
import { persistSet, SAVED_STATE } from "../shared/persist.ts";
import {
  inAppSpec,
  isInAppKey,
  isProjectKey,
  newProject,
  nextIn,
  PROJECT_COLORS,
  PROJECT_ICONS,
  PROJECTS,
  type Project,
  projectId,
  projectOf,
} from "../shared/projects.ts";
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

// A lane group's anchor is usually a generated placeholder workspace, but
// cmux can also anchor a single-member group on a real workspace (e.g. a
// group made from one existing tab), and that one belongs in its lane, its
// count and Needs you like any other card.
//
// The renderer's data has no "generated" flag for a workspace (issue #7), so
// this is a heuristic pending one: a generated anchor's title always matches
// its group's name and it carries no agents, so anything else showing under
// that title, or any agents at all, means it is a real workspace instead.
function isGeneratedAnchor(g: WorkspaceGroup, w: Workspace | undefined): boolean {
  if (!w) return true;
  if ((w.agents ?? []).length > 0) return false;
  return (w.title ?? "").trim().toLowerCase() === g.name.trim().toLowerCase();
}

// Each lane group's generated anchor is not a real card; a real workspace
// used as an anchor is.
export function laneAnchorIds(): Set<string> {
  const out = new Set<string>();
  for (const lane of LANES) {
    const g = groupForLane(lane);
    if (g?.anchorId && isGeneratedAnchor(g, wsById(g.anchorId))) out.add(g.anchorId);
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

// "Move to project" override (issue #8): no cmux field holds project
// membership. Seeded from the saved state at startup, and moveToProject and
// clearProjectOverride call persistSet, so a choice survives a reload.
// Never pruned: a workspace missing from one frame may be cmux still starting
// up or refreshing, and an entry for a closed workspace is unreachable and
// capped by the state file. Consulted before the path match, the way laneOf
// consults laneOverride, but with no decay: nothing in cmux ever supersedes
// it.
// wsId -> project key
const projectOverride = new Map<string, string>(
  Object.entries(SAVED_STATE.projectOverride).filter(([, key]) => isProjectKey(key)),
);
// Declared here, above allWorkspaces(), because the renderer evaluates a
// computed() as soon as it is defined, so its reads run during module load.

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

export const projectKey = (w: Workspace): string => {
  tick();
  const o = projectOverride.get(w.id);
  if (o) return o;
  const p = projectOf(w.directory);
  return PROJECTS.includes(p) ? projectId(p) : projectId(OTHER);
};

/** Move a workspace to a project, kept across a reload until cleared. Used by the context menu. */
export function moveToProject(w: Workspace | undefined, key: string): void {
  if (!w || !isProjectKey(key)) return;
  projectOverride.set(w.id, key);
  bump();
  persistSet(`projectOverride.${w.id}`, key);
}

/** Drop the override, so the workspace falls back to its path match. */
export function clearProjectOverride(w: Workspace | undefined): void {
  if (!w || !projectOverride.delete(w.id)) return;
  bump();
  persistSet(`projectOverride.${w.id}`, null);
}

// --- Projects made in the sidebar (issue #9) ------------------------------------------
// Each save rebuilds and reloads the sidebar, but until that lands a second
// tap must step on from the first, so the last spec sent is held here
// (null once removed). Not reactive on its own: bump() after each write.
const sentSpecs = new Map<string, ProjectSpec | null>();

const specOf = (k: string): ProjectSpec | undefined =>
  sentSpecs.has(k) ? (sentSpecs.get(k) ?? undefined) : inAppSpec(k);

/** The card's project key when that project was made in the sidebar and not removed since. */
function inAppKeyOf(w: Workspace | undefined): string | null {
  if (!w) return null;
  const k = projectKey(w);
  return isInAppKey(k) && specOf(k) ? k : null;
}

/** True when the card's folder matches no project, so it can become one. */
export const canCreateProject = (w: Workspace | undefined): boolean =>
  !!w && !PROJECTS.includes(projectOf(w.directory)) && newProject(w.directory, PROJECTS) !== null;

/** The name of the card's sidebar-made project, or null when it is in a file project or none. */
export const inAppProjectName = (w: Workspace | undefined): string | null => {
  tick();
  const k = inAppKeyOf(w);
  return k ? (specOf(k)?.name ?? null) : null;
};

function sendSpec(k: string, spec: ProjectSpec | null): void {
  sentSpecs.set(k, spec);
  bump();
  persistSet(`projects.${k}`, spec);
}

/** Makes the card's folder a project, named after the folder. */
export function createProjectFrom(w: Workspace | undefined): void {
  if (!w || !canCreateProject(w)) return;
  const made = newProject(w.directory, PROJECTS);
  if (made) sendSpec(made.key, made.spec);
}

function restyle(w: Workspace | undefined, change: (s: ProjectSpec) => ProjectSpec): void {
  const k = inAppKeyOf(w);
  const spec = k ? specOf(k) : undefined;
  if (k && spec) sendSpec(k, change(spec));
}

export const cycleProjectColor = (w: Workspace | undefined): void =>
  restyle(w, (s) => ({ ...s, color: nextIn(PROJECT_COLORS, s.color) }));

export const cycleProjectIcon = (w: Workspace | undefined): void =>
  restyle(w, (s) => ({ ...s, icon: nextIn(PROJECT_ICONS, s.icon) }));

/** Deletes the card's sidebar-made project; its workspaces fall back to path matching. */
export function removeProject(w: Workspace | undefined): void {
  const k = inAppKeyOf(w);
  if (k) sendSpec(k, null);
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

/** Whether the project's header should offer "+": it has a folder to open. */
export const canOpenProject = (k: string): boolean => !!projectByKey(k).root;

/** Opens a new workspace in the project's root, if it has one. */
export function openProjectWorkspace(k: string): void {
  const root = projectByKey(k).root;
  if (!root) return;
  cmux("workspace.create", { cwd: root, focus: true });
}

export type ProjectEntry =
  | { kind: "header"; id: string; project: string }
  | { kind: "ws"; id: string; wsId: string }
  | { kind: "empty"; id: string };

export const projectEntries = computed(() => {
  if (!projectsMode()) return [];
  const cards = cardWorkspaces();
  const entries: ProjectEntry[] = [];
  // Every configured project shows, even with no sessions; Other only shows
  // once something actually falls into it.
  for (const p of PROJECTS) {
    const k = projectId(p);
    const rows = cards.filter((w) => projectKey(w) === k);
    entries.push({ kind: "header", id: "p:" + k, project: k });
    if (isProjectCollapsed(k)) continue;
    if (!rows.length) {
      entries.push({ kind: "empty", id: "p:" + k + ":empty" });
      continue;
    }
    // One row shape in Projects mode, so the lane no longer rides in the id.
    for (const w of rows) entries.push({ kind: "ws", id: w.id + "@p", wsId: w.id });
  }
  const otherKey = projectId(OTHER);
  const otherRows = cards.filter((w) => projectKey(w) === otherKey);
  if (otherRows.length) {
    entries.push({ kind: "header", id: "p:" + otherKey, project: otherKey });
    if (!isProjectCollapsed(otherKey)) {
      for (const w of otherRows) entries.push({ kind: "ws", id: w.id + "@p", wsId: w.id });
    }
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
