// Workspaces as the cockpit sees them: which lane each is in, selection and
// collapse, and the row lists each mode renders.
//
// Optimistic overrides flip locally the same frame, then clear once the data
// agrees or after OVERRIDE_SECS (so a normalised result from the app wins).

import type { ProjectSpec, ViewMode } from "../../scripts/state-config.ts";
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
  savedFolds,
  setCollapsedProjects,
  setMode,
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

// A lane with no cmux group yet (a fresh window has only the ones made by
// hand) gets one on its first move. cmux() returns nothing, so the new
// group's id arrives in a later frame: the move waits here until then, and
// the card holds its new lane for up to CREATE_SECS instead of OVERRIDE_SECS.
const CREATE_SECS = 30;
const awaitingGroup = new Map<string, { lane: LaneKey; at: number }>(); // wsId -> lane being made

export function laneOf(w: Workspace): LaneKey {
  tick();
  const actual = actualLaneOf(w);
  const o = laneOverride.get(w.id);
  if (o) {
    const wait = awaitingGroup.has(w.id) ? CREATE_SECS : OVERRIDE_SECS;
    if (o.lane === actual || nowEpoch() - o.at > wait) laneOverride.delete(w.id);
    else return o.lane;
  }
  return actual;
}

// Move a workspace into a lane (no reorder). Used by the context menu and drops.
export function moveToLane(w: Workspace | undefined, laneKey: LaneKey): void {
  if (!w || actualLaneOf(w) === laneKey) return;
  awaitingGroup.delete(w.id);
  if (laneKey === "unsorted") {
    cmux("workspace.group.remove", { workspace_id: w.id });
  } else {
    const lane = laneByKey(laneKey);
    const g = groupForLane(lane);
    if (g) cmux("workspace.group.add", { group_id: g.id, workspace_id: w.id });
    else requestLaneGroup(w.id, lane);
  }
  laneOverride.set(w.id, { lane: laneKey, at: nowEpoch() });
  bump();
}

// No --from, so cmux makes a generated anchor and the card stays draggable
// (a real anchor is pinned, see drop.ts). The idempotency key makes a second
// drop before the group arrives return the same group, not a second one.
function requestLaneGroup(wsId: string, lane: Lane): void {
  const inFlight = [...awaitingGroup.values()].some((p) => p.lane === lane.key);
  awaitingGroup.set(wsId, { lane: lane.key, at: nowEpoch() });
  if (!inFlight) cmux("workspace.group.create", { name: lane.name, idempotency_key: `cockpit-lane-${lane.key}` });
}

// Runs on every frame's read of the workspaces, since the renderer has no
// effect hook: files each waiting card once its lane's group shows up, and
// drops a wait that has outlived CREATE_SECS, so a late group never pulls
// back a card that already fell back.
function fileAwaitingCards(): void {
  for (const [wsId, p] of awaitingGroup) {
    if (nowEpoch() - p.at > CREATE_SECS) {
      awaitingGroup.delete(wsId);
      continue;
    }
    const g = groupForLane(laneByKey(p.lane));
    if (!g) continue;
    awaitingGroup.delete(wsId);
    cmux("workspace.group.add", { group_id: g.id, workspace_id: wsId });
    laneOverride.set(wsId, { lane: p.lane, at: nowEpoch() });
  }
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
  fileAwaitingCards();
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
// A lane with a saved flag has been toggled before, so startsCollapsed no
// longer applies to it after a reload.
const touchedLanes = new Set<LaneKey>(LANES.filter((l) => `lane:${l.key}` in savedFolds).map((l) => l.key));

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
    saveFolds();
    return;
  }
  const g = groupForLane(lane);
  if (!g) return;
  collapseOverride.set(g.id, next);
  bump();
  cmux(next ? "workspace.group.collapse" : "workspace.group.expand", { group_id: g.id });
  saveFolds();
}

// Sends every fold at once, so the saved copy never lags a quick second tap.
// cmux holds a lane group's own fold; its flag marks it as touched, and only
// Unsorted's value is read back. Folds on projects that are gone are dropped,
// and keys are sorted so the same folds always write the same file.
function saveFolds(): void {
  const folds: [string, number][] = [];
  for (const lane of LANES) if (touchedLanes.has(lane.key)) folds.push([`lane:${lane.key}`, isCollapsed(lane) ? 1 : 0]);
  for (const k of collapsedProjects()) if (isProjectKey(k) || k === projectId(OTHER)) folds.push([`project:${k}`, 1]);
  folds.sort(([a], [b]) => (a < b ? -1 : 1));
  persistSet("ui.collapsed", folds.length ? Object.fromEntries(folds) : null);
}

/** Switches between All and Projects, kept across a reload. */
export function chooseMode(m: ViewMode): void {
  if (mode() === m) return;
  setMode(m);
  persistSet("ui.mode", m);
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

// Every project, plus those sent but not built yet, so two quick creates
// never pick the same name or colour.
function knownProjects(): Project[] {
  const sent = [...sentSpecs].flatMap(([match, s]) => (s ? [{ match, ...s }] : []));
  return [...PROJECTS, ...sent];
}

/** True when the card sits in Other (no path match, no override), so its folder can become a project. */
export function canCreateProject(w: Workspace | undefined): boolean {
  if (!w || projectKey(w) !== projectId(OTHER)) return false;
  const made = newProject(w.directory, knownProjects());
  // Already sent and waiting on the rebuild: a second tap would only rename it.
  return made !== null && !sentSpecs.get(made.key);
}

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
  const made = w && canCreateProject(w) ? newProject(w.directory, knownProjects()) : null;
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

/**
 * Deletes the card's sidebar-made project and every override pointing at it,
 * so remaking the same folder later does not pull those workspaces back in.
 */
export function removeProject(w: Workspace | undefined): void {
  const k = inAppKeyOf(w);
  if (!k) return;
  for (const [id, key] of [...projectOverride]) {
    if (key !== k) continue;
    projectOverride.delete(id);
    persistSet(`projectOverride.${id}`, null);
  }
  sendSpec(k, null);
}

export const hasProjectOverride = (w: Workspace | undefined): boolean => {
  tick();
  return !!w && projectOverride.has(w.id);
};

export const projectByKey = (k: string): Project => PROJECTS.find((p) => projectId(p) === k) ?? OTHER;
export const isProjectCollapsed = (k: string) => collapsedProjects().includes(k);
export function toggleProject(k: string): void {
  setCollapsedProjects(
    isProjectCollapsed(k) ? collapsedProjects().filter((x) => x !== k) : [...collapsedProjects(), k],
  );
  saveFolds();
}
export const projectCount = (k: string) => cardWorkspaces().filter((w) => projectKey(w) === k).length;

/** Whether the project's header should offer "+": it has a folder to open. */
export const canOpenProject = (k: string): boolean => !!projectByKey(k).root;

/** Opens a new workspace in the project's root, if it has one. */
export function openProjectWorkspace(k: string): void {
  const root = projectByKey(k).root;
  if (!root) return;
  cmux("workspace.create", { cwd: root, focus: true });
}

/** The card menu's new session label. Menu items are fixed when the card is
 * built, so a project with no folder says why instead of vanishing. */
export function newSessionLabel(w: Workspace | undefined): string {
  if (!w) return "New session (no workspace)";
  const k = projectKey(w);
  return canOpenProject(k) ? `New session in ${projectByKey(k).name}` : "New session (project has no folder)";
}

/** Opens a new session in the card's project folder; a no-op without one. */
export function newSessionFor(w: Workspace | undefined): void {
  if (w) openProjectWorkspace(projectKey(w));
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
