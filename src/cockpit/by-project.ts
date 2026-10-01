// Projects mode: which project each card is in, projects made in the sidebar, and its rows.

import type { ProjectSpec } from "../../scripts/state-config.ts";
import { expandHome, isHome, trimSlash } from "../shared/home.ts";
import { persistSet, SAVED_STATE } from "../shared/persist.ts";
import {
  isProjectKey,
  newProject,
  PROJECTS,
  type Project,
  projectFor,
  projectId,
  savedSpec,
} from "../shared/projects.ts";
import { type Lane, laneByKey } from "./lanes.ts";
import {
  allWorkspaces,
  cards,
  cardWorkspaces,
  groupForLane,
  isCollapsed,
  OTHER,
  saveFolds,
  toggleLane,
} from "./model.ts";
import {
  bump,
  collapsedProjects,
  editingProject,
  NEW_PROJECT,
  quietCollapsed,
  setCollapsedProjects,
  setQuietCollapsed,
  tick,
} from "./state.ts";
import { inStrip } from "./strip.ts";

// --- Projects mode ---------------------------------------------------------------------
// PROJECTS order, then Other; empty projects are skipped. Grouped by project,
// not by match, so a project with several paths is one group. Collapse is
// local only: projects are not cmux groups.

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
// Declared here, above every computed() in this file, because the renderer
// evaluates a computed() as soon as it is defined, so its reads run during module load.

/** A workspace's project: its Move to project choice while that stands, else its path match, else Other. */
export const projectOfWorkspace = (w: Workspace | undefined): Project => {
  if (!w) return OTHER;
  tick();
  const p = projectFor(w.directory, projectOverride.get(w.id));
  return PROJECTS.includes(p) ? p : OTHER;
};

export const projectKey = (w: Workspace): string => projectId(projectOfWorkspace(w));

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

// --- Projects made or edited in the sidebar (issue #9) ---------------------------------
// Each save rebuilds and reloads the sidebar, but until that lands the editor
// must open on what was last sent, so the last spec sent is held here (null
// once removed). Not reactive on its own: bump() after each write.
const sentSpecs = new Map<string, ProjectSpec | null>();

const builtProject = (k: string): Project | undefined => PROJECTS.find((p) => projectId(p) === k);

/** The project as it now stands: the last spec sent, else its saved or built one. Undefined once removed, or for Other. */
export function specOf(k: string): ProjectSpec | undefined {
  if (sentSpecs.has(k)) return sentSpecs.get(k) ?? undefined;
  const p = builtProject(k);
  if (!p) return undefined;
  return savedSpec(k) ?? { name: p.name, color: p.color, icon: p.icon, ...(p.root ? { root: p.root } : {}) };
}

/** Every project as it now stands, keyed by its first match, sent but not built ones included. */
export function knownProjects(): Project[] {
  tick();
  const keys = new Set([...PROJECTS.map(projectId), ...sentSpecs.keys()]);
  return [...keys].flatMap((k) => {
    const spec = specOf(k);
    return spec ? [{ match: k, ...spec }] : [];
  });
}

/** True when the card sits in Other (no path match, no override), so its folder can become a project. */
export function canCreateProject(w: Workspace | undefined): boolean {
  tick();
  if (!w || projectKey(w) !== projectId(OTHER) || isHome(w.directory)) return false;
  const made = newProject(w.directory, knownProjects());
  // Already sent and waiting on the rebuild: a second tap would only rename it.
  return made !== null && !sentSpecs.get(made.key);
}

/** True once the project was removed in the sidebar, before the rebuild drops it. Reactive. */
function isRemovedProject(k: string): boolean {
  tick();
  return sentSpecs.has(k) && sentSpecs.get(k) === null;
}

/** Saves a project's name, colour, icon and folder. */
export function saveProject(k: string, spec: ProjectSpec): void {
  sentSpecs.set(k, spec);
  bump();
  persistSet(`projects.${k}`, spec);
}

/** Makes the card's folder a project, named after the folder. */
export function createProjectFrom(w: Workspace | undefined): void {
  const made = w && canCreateProject(w) ? newProject(w.directory, knownProjects()) : null;
  if (made) saveProject(made.key, made.spec);
}

/** The card chip's words: `Make "Pianola" a project`, named as the project would be. */
export function makeProjectLabel(w: Workspace | undefined): string {
  const name = newProject(w?.directory, knownProjects())?.spec.name;
  return name ? `Make "${name}" a project` : "Make a project";
}

const MAX_SUGGESTIONS = 3;
const folderKey = (dir: string | undefined): string => trimSlash(String(dir ?? "")).toLowerCase();

/** Folders of open workspaces that could become a project, each once, for the new project editor. Reactive. */
export const folderSuggestions = computed((): string[] => {
  const dirs = new Map<string, string>();
  for (const w of cards()) {
    if (canCreateProject(w) && w.directory) dirs.set(folderKey(w.directory), trimSlash(w.directory));
  }
  return [...dirs.values()].slice(0, MAX_SUGGESTIONS);
});

/** Opens a workspace in `dir`, unless one is open there already. */
export function openFolderOnce(dir: string): void {
  if (allWorkspaces().some((w) => folderKey(w.directory) === folderKey(dir))) return;
  cmux("workspace.create", { cwd: dir, focus: true });
}

/**
 * Removes a project and every override pointing at it, so remaking the same
 * folder later does not pull those workspaces back in. One from
 * projects.json is saved as removed, since deleting its entry would bring
 * the file's back on the next build.
 */
export function removeProject(k: string): void {
  if (!specOf(k)) return;
  for (const [id, key] of [...projectOverride]) {
    if (key !== k) continue;
    projectOverride.delete(id);
    persistSet(`projectOverride.${id}`, null);
  }
  sentSpecs.set(k, null);
  bump();
  persistSet(`projects.${k}`, builtProject(k)?.seeded ? { removed: true } : null);
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
/** The cards a project header counts and tints its pill by, as laneWorkspaces is for a lane. */
export const projectWorkspaces = (k: string): Workspace[] => cards().filter((w) => projectKey(w) === k);

/** Whether the project's header should offer "+": it has a folder to open. */
export const canOpenProject = (k: string): boolean => !!projectByKey(k).root;

/**
 * The folder "+" opens: until the rebuild lands, the last root sent, its "~"
 * expanded as build.ts will, else the built one.
 */
function rootToOpen(k: string): string | undefined {
  const sent = sentSpecs.get(k)?.root;
  const dir = sent === undefined ? null : expandHome(sent);
  return dir?.startsWith("/") ? dir : projectByKey(k).root;
}

/** Opens a new workspace in the project's root, if it has one. A folded
 * project unfolds first, so the new card is not hidden under its header.
 * Given a lane whose group exists, it opens at the top of that group, which
 * unfolds for the same reason; with no group yet it opens ungrouped. */
export function openProjectWorkspace(k: string, lane?: Lane): void {
  const root = rootToOpen(k);
  if (!root) return;
  if (isProjectCollapsed(k)) toggleProject(k);
  const g = lane ? groupForLane(lane) : null;
  if (lane && g && isCollapsed(lane)) toggleLane(lane);
  const into: { group_id?: string; group_placement?: "top" } = g ? { group_id: g.id, group_placement: "top" } : {};
  cmux("workspace.create", { cwd: root, focus: true, ...into });
}

const openLabel = (k: string): string => `New session in ${projectByKey(k).name}`;

/** The card menu's new session label. Menu items are fixed when the card is
 * built, so a project with no folder says why instead of vanishing. */
export function newSessionLabel(w: Workspace | undefined): string {
  if (!w) return "New session (no workspace)";
  return projectNewLabel(projectKey(w));
}

/** Opens a new session in the card's project folder, a no-op without one.
 * It lands in Main activity, since Jon is about to work in it. */
export function newSessionFor(w: Workspace | undefined): void {
  if (w) openProjectWorkspace(projectKey(w), laneByKey("main"));
}

/** A project menu's first item: what it opens, or why it opens nothing. */
export const projectNewLabel = (k: string): string =>
  canOpenProject(k) ? openLabel(k) : "New session (project has no folder)";

/** A quiet row's menu label: what a tap does, or why it does nothing. */
export const quietLabel = (k: string): string =>
  canOpenProject(k) ? openLabel(k) : `${projectByKey(k).name} has no folder to open`;

export type ProjectEntry =
  | { kind: "header"; id: string; project: string }
  | { kind: "ws"; id: string; wsId: string }
  | { kind: "ghost"; id: string; wsId: string }
  | { kind: "quietHeader"; id: string }
  | { kind: "quietRow"; id: string; project: string }
  | { kind: "editor"; id: string; project: string }
  | { kind: "newRow"; id: string };

// The open editor sits under its project's header or quiet row, with its own
// key, since a row's kind is fixed by its key.
function pushEditor(entries: ProjectEntry[], k: string): void {
  if (editingProject() === k) entries.push({ kind: "editor", id: "e:" + k, project: k });
}

/** The cards grouped by project key, in one pass over the cards. */
const cardsByProject = computed(() => {
  const groups = new Map<string, Workspace[]>();
  for (const w of cards()) {
    const k = projectKey(w);
    const rows = groups.get(k);
    if (rows) rows.push(w);
    else groups.set(k, [w]);
  }
  return groups;
});

/**
 * Configured projects with no sessions, in table order (issue #54). They sit
 * under one "Quiet" header as a short row each rather than a full header.
 * A project whose only sessions wait in Needs you is not quiet: it keeps
 * its header (projectEntries).
 */
export const quietProjects = computed(() => {
  const busy = new Set(cardWorkspaces().map(projectKey));
  return PROJECTS.map(projectId).filter((k) => !busy.has(k) && !isRemovedProject(k));
});

/** Folds or unfolds the Quiet rows, kept across a reload. */
export function toggleQuiet(): void {
  setQuietCollapsed(!quietCollapsed());
  saveFolds();
}

function pushGroup(entries: ProjectEntry[], k: string, rows: readonly Workspace[]): void {
  entries.push({ kind: "header", id: "p:" + k, project: k });
  pushEditor(entries, k);
  if (isProjectCollapsed(k)) return;
  // One row shape in Projects mode, so the lane no longer rides in the id.
  // A session in the Needs you strip leaves a placeholder in its place.
  const waiting = inStrip();
  for (const w of rows) {
    entries.push(
      waiting.has(w.id) ? { kind: "ghost", id: w.id + "@g", wsId: w.id } : { kind: "ws", id: w.id + "@p", wsId: w.id },
    );
  }
}

export const projectEntries = computed(() => {
  const groups = cardsByProject();
  // A project whose sessions all wait in Needs you keeps its header over
  // their placeholders, so its "+" and an open editor stay.
  const busy = new Set(groups.keys());
  const entries: ProjectEntry[] = [];
  // A project with sessions gets a header; the quiet ones share one header at
  // the bottom, a short row each. Other only shows once something falls into it.
  // A project removed before the rebuild loses its header at once; its
  // cards wait in Other, where the rebuild will put them.
  const gone = PROJECTS.map(projectId).filter(isRemovedProject);
  const other = [...(groups.get(projectId(OTHER)) ?? []), ...gone.flatMap((k) => groups.get(k) ?? [])];
  for (const k of PROJECTS.map(projectId)) {
    if (busy.has(k) && !gone.includes(k)) pushGroup(entries, k, groups.get(k) ?? []);
  }
  const otherBusy = [projectId(OTHER), ...gone].some((k) => busy.has(k));
  if (otherBusy) pushGroup(entries, projectId(OTHER), other);
  // "+ New project" and its editor, above the quiet ones.
  entries.push({ kind: "newRow", id: "new" });
  pushEditor(entries, NEW_PROJECT);
  const quiet = quietProjects();
  if (!quiet.length) return entries;
  // Ids outside the "p:" space, so a project matching "quiet" cannot clash.
  entries.push({ kind: "quietHeader", id: "quiet" });
  if (quietCollapsed()) return entries;
  for (const k of quiet) {
    entries.push({ kind: "quietRow", id: "q:" + k, project: k });
    pushEditor(entries, k);
  }
  return entries;
});
