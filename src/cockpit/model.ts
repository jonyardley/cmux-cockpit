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
import { type PrHealth, prSummary } from "../shared/prs.ts";
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
import { isReady, sinceOf, statusOf } from "./status.ts";

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
// cmux's own group list says which anchors it generated, but the renderer's
// data has no such flag (issue #7), so this is a heuristic pending one: a
// generated anchor's title always matches its group's name, so an anchor
// under that title is the placeholder even with agents running in it (they
// show on the lane header instead). It gets two cases wrong: a real
// workspace Jon titles exactly after its lane hides as the placeholder, and
// a placeholder he renames shows as a card.
function isGeneratedAnchor(g: WorkspaceGroup, w: Workspace | undefined): boolean {
  if (!w) return true;
  return (w.title ?? "").trim().toLowerCase() === g.name.trim().toLowerCase();
}

// Each lane group's generated anchor is not a real card; a real workspace
// used as an anchor is.
export function laneAnchorIds(): Set<string> {
  const out = new Set<string>();
  for (const lane of LANES) {
    const id = generatedAnchorId(lane);
    if (id) out.add(id);
    else if (!groupForLane(lane) && awaitingLane(lane.key)) hideNewAnchor(lane, out);
  }
  return out;
}

// The lane group's generated anchor, if it has one. A workspace not in the
// data yet counts, so it never flashes up as a card when it arrives.
function generatedAnchorId(lane: Lane): string | null {
  const g = groupForLane(lane);
  return g?.anchorId && isGeneratedAnchor(g, wsById(g.anchorId)) ? g.anchorId : null;
}

// cmux can publish a new group's anchor a frame before the group itself, so
// while a lane's group is on its way, an ungrouped workspace that looks like
// its anchor is hidden rather than shown in Unsorted.
function hideNewAnchor(lane: Lane, out: Set<string>): void {
  const name = lane.name.trim().toLowerCase();
  for (const w of data.workspaces() ?? []) {
    if (!w.group && (w.agents ?? []).length === 0 && (w.title ?? "").trim().toLowerCase() === name) out.add(w.id);
  }
}

export function actualLaneOf(w: Workspace | undefined): LaneKey {
  if (!w?.group) return "unsorted";
  for (const lane of LANES) {
    const g = groupForLane(lane);
    if (g && g.id === w.group) return lane.key;
  }
  return "unsorted";
}

// A lane with no cmux group yet (a fresh window has only the ones made by
// hand) gets one on its first move. cmux() returns nothing, so the new
// group's id arrives in a later frame: the move is marked `awaiting` until
// then, and holds its lane for up to CREATE_SECS instead of OVERRIDE_SECS.
const CREATE_SECS = 30;
interface LaneMove {
  lane: LaneKey;
  at: number;
  awaiting?: boolean;
}
const laneOverride = new Map<string, LaneMove>(); // wsId -> pending move

const expired = (o: LaneMove): boolean => nowEpoch() - o.at > (o.awaiting ? CREATE_SECS : OVERRIDE_SECS);

const awaitingLane = (key: LaneKey): boolean =>
  [...laneOverride.values()].some((o) => o.awaiting && o.lane === key && !expired(o));

export function laneOf(w: Workspace): LaneKey {
  tick();
  const actual = actualLaneOf(w);
  const o = laneOverride.get(w.id);
  if (o) {
    if (o.lane === actual || expired(o)) laneOverride.delete(w.id);
    else return o.lane;
  }
  return actual;
}

// Move a workspace into a lane (no reorder). Used by the context menu and drops.
// Moving a card back to where cmux still has it cancels the pending move, so
// a group that arrives later never files it against the last choice.
// A lane's generated anchor IS its group, so it never moves (Needs you still
// lists one, with the card menu).
export function moveToLane(w: Workspace | undefined, laneKey: LaneKey): void {
  if (!w || laneAnchorIds().has(w.id)) return;
  if (actualLaneOf(w) === laneKey) {
    if (laneOverride.delete(w.id)) bump();
    return;
  }
  const lane = laneByKey(laneKey);
  const g = groupForLane(lane);
  if (laneKey === "unsorted") cmux("workspace.group.remove", { workspace_id: w.id });
  else if (g) cmux("workspace.group.add", { group_id: g.id, workspace_id: w.id });
  else requestLaneGroup(lane);
  laneOverride.set(w.id, { lane: laneKey, at: nowEpoch(), awaiting: laneKey !== "unsorted" && !g });
  bump();
}

// No --from, so cmux makes a generated anchor and the card stays draggable
// (a real anchor is pinned, see drop.ts). One request per wait: a second card
// dropped before the group arrives waits on the same one. The key is fresh
// each time, since a fixed one would keep returning a group Jon has since
// ungrouped.
function requestLaneGroup(lane: Lane): void {
  if (awaitingLane(lane.key)) return;
  cmux("workspace.group.create", { name: lane.name, idempotency_key: `cockpit-lane-${lane.key}-${nowEpoch()}` });
}

// The renderer has no effect hook, so this runs from allWorkspaces(), the
// read every frame starts with. It is idempotent: an entry is filed or
// dropped once, whichever read reaches it first. Each waiting card whose
// group has shown up moves to just after the group's run of tabs, then joins
// it (position first, as handleMove does, or cmux can file it into the group
// above). A wait past CREATE_SECS is dropped, so a late group never pulls
// back a card that already fell back.
function fileAwaitingCards(): void {
  let changed = false;
  for (const [wsId, o] of laneOverride) {
    if (!o.awaiting) continue;
    if (expired(o)) {
      laneOverride.delete(wsId);
      changed = true;
      continue;
    }
    const g = groupForLane(laneByKey(o.lane));
    if (!g) continue;
    const at = indexAfterGroup(wsId, g);
    if (at >= 0) cmux("workspace.reorder", { workspace_id: wsId, index: at });
    cmux("workspace.group.add", { group_id: g.id, workspace_id: wsId });
    laneOverride.set(wsId, { lane: o.lane, at: nowEpoch() });
    changed = true;
  }
  if (changed) bump();
}

// The tab index, among the other tabs, just after the group's last member.
function indexAfterGroup(wsId: string, g: WorkspaceGroup): number {
  const others = (data.workspaces() ?? []).filter((x) => x.id !== wsId);
  const last = others.filter((x) => x.group === g.id || x.id === g.anchorId).at(-1);
  return last ? others.indexOf(last) + 1 : -1;
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

// A header's key carries the anchor it shows (issue #49), and an empty lane
// is a zone or part of the folded line (issue #50), since a row's kind is
// fixed by its key.
export type LaneEntry =
  | { kind: "header"; id: string; lane: LaneKey; anchorId: string | null }
  | { kind: "zone"; id: string; lane: LaneKey }
  | { kind: "fold"; id: string }
  | { kind: "ws"; id: string; wsId: string; lane: LaneKey };

/** A lane's generated anchor when it has an agent or unread messages, so its header shows them. */
function headerAnchorId(lane: Lane): string | null {
  const id = generatedAnchorId(lane);
  const w = id ? wsById(id) : undefined;
  return w && ((w.agents ?? []).length > 0 || (w.unread ?? 0) > 0) ? w.id : null;
}

interface LaneSection {
  lane: Lane;
  rows: Workspace[];
  anchorId: string | null;
}

// Nothing to show: no cards, and no anchor status on the header.
const isEmpty = (s: LaneSection): boolean => s.rows.length === 0 && !s.anchorId;

const laneSections = computed((): LaneSection[] => {
  const cards = cardWorkspaces();
  return LANES.map((lane) => ({
    lane,
    rows: cards.filter((w) => laneOf(w) === lane.key),
    anchorId: headerAnchorId(lane),
  }));
});

function sectionEntries(s: LaneSection): LaneEntry[] {
  const key = s.lane.key;
  const header: LaneEntry = {
    kind: "header",
    id: s.anchorId ? `h:${key}:${s.anchorId}` : `h:${key}`,
    lane: key,
    anchorId: s.anchorId,
  };
  if (isCollapsed(s.lane)) return [header];
  return [header, ...s.rows.map((w): LaneEntry => ({ kind: "ws", id: w.id + "@" + key, wsId: w.id, lane: key }))];
}

// An empty lane is always a zone row in its own place, and the folded line
// follows the lanes; views/headers.ts shows one or the other by drag(). The
// rows never change as a drag starts or ends, so the renderer's drop index
// always counts the same rows resolveDrop does.
const laneEntries = computed(() => {
  const entries: LaneEntry[] = [];
  let folded = false;
  for (const s of laneSections()) {
    if (!isEmpty(s)) entries.push(...sectionEntries(s));
    else {
      entries.push({ kind: "zone", id: "z:" + s.lane.key, lane: s.lane.key });
      folded = true;
    }
  }
  if (folded) entries.push({ kind: "fold", id: "f:empty" });
  return entries;
});

/** The empty lanes' names, in lane order, for the folded line. */
export const emptyLaneNames = (): string[] =>
  laneSections()
    .filter(isEmpty)
    .map((s) => s.lane.name);

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

/**
 * Workspaces waiting on Jon, longest-waiting first. A lane's generated
 * anchor counts too: it is off the cards, but an agent in it can still ask.
 */
export const needsList = computed(() =>
  allWorkspaces()
    .filter((w) => statusOf(w) === "needs_input")
    .sort((a, b) => sinceOf(a) - sinceOf(b)),
);

// --- Card chips (issue #48) ------------------------------------------------------------

export type ChipId = "pr" | "br" | "port";

export interface Chip {
  id: ChipId;
  text: string;
  url?: string;
  status?: PrStatus;
  health?: PrHealth;
  draft?: boolean;
  /** The branch chip's uncommitted-changes dot. */
  dirty?: boolean;
}

const isPort = (p: number): boolean => Number.isInteger(p) && p > 0 && p < 65536;

function portChip(ports: readonly number[] | undefined): Chip | null {
  const list = [...new Set((ports ?? []).filter(isPort))];
  const [first] = list;
  if (first === undefined) return null;
  const more = list.length > 1 ? " +" + (list.length - 1) : "";
  return { id: "port", text: ":" + first + more + " ↗", url: "http://localhost:" + first };
}

/** A card's chips, in order: the PR, the branch (when asked for), the ports. */
export function chipsFor(w: Workspace | undefined, withBranch: boolean): Chip[] {
  const out: Chip[] = [];
  if (!w) return out;
  const pr = prSummary(w);
  if (pr) {
    const c: Chip = { id: "pr", text: pr.text, health: pr.health, draft: pr.draft };
    if (pr.url) c.url = pr.url;
    if (pr.status) c.status = pr.status;
    out.push(c);
  }
  if (withBranch && w.branch) out.push({ id: "br", text: w.branch, dirty: !!w.dirty });
  const port = portChip(w.ports);
  if (port) out.push(port);
  return out;
}

// Ready cards (issue #53).

/** A Ready card offers "To review", unless it is already in For review (or is a lane's anchor, which never moves). */
export function canFileForReview(w: Workspace | undefined): boolean {
  return !!w && isReady(w) && laneOf(w) !== "review" && !laneAnchorIds().has(w.id);
}

/** Files a Ready card into For review. */
export const fileForReview = (w: Workspace | undefined): void => moveToLane(w, "review");

/** True when a card's chips row has anything to show: a chip, or the To review action. */
export const hasChipsRow = (w: Workspace | undefined, withBranch: boolean): boolean =>
  chipsFor(w, withBranch).length > 0 || canFileForReview(w);
