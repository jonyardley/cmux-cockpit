// Workspaces as the cockpit sees them: which lane each is in, selection and
// collapse, and the row lists each mode renders.
//
// Optimistic overrides flip locally the same frame, then clear once the data
// agrees or after OVERRIDE_SECS (so a normalised result from the app wins).

import type { ProjectSpec, ViewMode } from "../../scripts/state-config.ts";
import { isGeneratedAnchor } from "../shared/anchors.ts";
import { expandHome, isHome, trimSlash } from "../shared/home.ts";
import { type MoveSize, moveSize, moveSizeText } from "../shared/move.ts";
import { dismissNeeds, isNeedsDismissed } from "../shared/needs.ts";
import { P } from "../shared/palette.ts";
import { persistSet, SAVED_STATE } from "../shared/persist.ts";
import { READY_INK } from "../shared/pr-colors.ts";
import {
  isProjectKey,
  newProject,
  PROJECTS,
  type Project,
  projectFor,
  projectId,
  savedSpec,
} from "../shared/projects.ts";
import { type PrHealth, prHealth, prSummary } from "../shared/prs.ts";
import { finishedAt, fmtAge, nowEpoch } from "../shared/time.ts";
import { LANES, type Lane, type LaneKey, laneByKey } from "./lanes.ts";
import {
  bump,
  collapsedProjects,
  drag,
  editingProject,
  isMode,
  isSelected,
  mode,
  NEW_PROJECT,
  OVERRIDE_SECS,
  quietCollapsed,
  savedFolds,
  selectWorkspace,
  setCollapsedProjects,
  setMode,
  setQuietCollapsed,
  setUnsortedCollapsed,
  tick,
  unsortedCollapsed,
} from "./state.ts";
import { isReady, moveOf, readyAgent, sinceOf, statusOf } from "./status.ts";
import { C } from "./theme.ts";

// --- groups and lanes ---------------------------------------------------------------

export const groups = (): WorkspaceGroup[] => data.groups() ?? [];

/** A workspace anchoring a group: it cannot leave it (drop.ts pins it), and closing it would take the lane. */
export const isAnchor = (w: Workspace): boolean => groups().some((g) => g.anchorId === w.id);

export const groupForLane = (lane: Lane): WorkspaceGroup | null =>
  lane.key === "unsorted" ? null : (groups().find((g) => g.name === lane.name) ?? null);

// Each lane group's generated anchor (shared/anchors.ts) is not a real card;
// a real workspace used as an anchor belongs in its lane, its count and
// Needs you like any other card.
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

/**
 * How big a card draws: by its lane in cmux's own data, not the lane a drop
 * shows it in at once. So a drop moves the card straight away but changes
 * its size only when cmux's data catches up, after the drag has ended:
 * cmux 0.64.25 keeps drawing views swapped out while it finishes a drag.
 */
export function cardDensity(w: Workspace | undefined): Lane["density"] {
  return laneByKey(actualLaneOf(w)).density;
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
// Unsorted's value is read back. The Quiet header saves only while folded. Folds on projects that are gone are dropped,
// and keys are sorted so the same folds always write the same file.
function saveFolds(): void {
  const folds: [string, number][] = [];
  for (const lane of LANES) if (touchedLanes.has(lane.key)) folds.push([`lane:${lane.key}`, isCollapsed(lane) ? 1 : 0]);
  for (const k of collapsedProjects()) if (isProjectKey(k) || k === projectId(OTHER)) folds.push([`project:${k}`, 1]);
  if (quietCollapsed()) folds.push(["quiet", 1]);
  folds.sort(([a], [b]) => (a < b ? -1 : 1));
  persistSet("ui.collapsed", folds.length ? Object.fromEntries(folds) : null);
}

/** Switches between All and Projects, kept across a reload. */
export function chooseMode(m: ViewMode): void {
  if (mode() === m) return;
  setMode(m);
  persistSet("ui.mode", m);
}

// Both panels stay built; switching tabs only flips these two live values,
// so neither list is torn down and rebuilt (the flicker). The hidden panel
// is transparent AND zero height, so it neither leaves blank space nor
// relies on the app ignoring taps on a transparent view. A slide between
// the panels would add an offset here, once the renderer can animate one.
/** 1 while `m` is the chosen mode, else 0: a live value for `.opacity()`. */
export const panelOpacity = (m: ViewMode) => (): number => (isMode(m)() ? 1 : 0);
/** Unbounded while `m` is the chosen mode, else 0: for `.frame({ maxHeight })`. */
export const panelMaxHeight = (m: ViewMode) => (): number | "infinity" => (isMode(m)() ? "infinity" : 0);

// --- Needs you ---------------------------------------------------------------------------

/**
 * Workspaces waiting on Jon, longest-waiting first. A lane's generated
 * anchor counts too: it is off the cards, but an agent in it can still ask.
 */
const oldestFirst = (a: Workspace, b: Workspace): number => sinceOf(a) - sinceOf(b);

export const needsList = computed(() =>
  allWorkspaces()
    .filter((w) => statusOf(w) === "needs_input")
    .sort(oldestFirst),
);

// The strip lists this many rows, then "+N more" (issue #74), so a long queue
// never pushes the lanes off screen.
const NEEDS_ROWS = 4;

export const needsShown = computed(() => needsList().slice(0, NEEDS_ROWS));

// The header's clock turns clay once the oldest ask has waited this long (issue #153).
export const NEEDS_LATE_SECS = 30 * 60;

/**
 * How long the oldest ask has waited in seconds, timed as its row is; null
 * with no timed ask or no clock. An untimed ask sorts first, so skip it
 * rather than let it blank the clock.
 */
const oldestWait = computed((): number | null => {
  const at = needsList()
    .map(sinceOf)
    .find((t) => t > 0);
  const now = nowEpoch();
  return at && now ? Math.max(0, now - at) : null;
});

/** The header's clock: "12m" for the oldest ask, "" when nothing says. */
export function needsWaitText(): string {
  const secs = oldestWait();
  return secs === null ? "" : fmtAge(secs);
}

/** Whether the oldest ask has waited 30 minutes or more. */
export const needsWaitLate = (): boolean => (oldestWait() ?? 0) >= NEEDS_LATE_SECS;

/** How many waiting workspaces the strip leaves out. */
export const needsMore = (): number => Math.max(0, needsList().length - NEEDS_ROWS);

/**
 * The sessions the Needs you strip lists. Their card leaves its lane or
 * project for a placeholder in the same spot, which the header still
 * counts, and comes back there once answered or dismissed. One past the
 * strip's cap keeps its card. The card being dragged stays a card even if
 * it starts asking, so it never vanishes from under the pointer. Above the
 * lanes and projects, since computed() runs on definition.
 */
/** Real cards, memoised once per change for every lane and project header that filters them. */
const cards = computed(cardWorkspaces);

const inStrip = computed((): ReadonlySet<string> => {
  const dragged = drag()?.id;
  return new Set(needsShown().flatMap((w) => (dragged === "w:" + w.id ? [] : [w.id])));
});

// Dismissing from Needs you leaves the card in the placeholder's spot, the
// top of its lane with the other waiting cards, rather than sorting it down
// as idle. It holds there until its status next changes, and a new ask
// releases it too (liveRank). A plain Map: read with tick(), set with
// bump(); a release during render needs no bump, since the status change
// that caused it already redraws.
const dismissedHold = new Map<string, string>();

/** Dismisses a waiting session from Needs you, holding its card where its placeholder sat. */
export function dismissWaiting(w: Workspace | undefined): void {
  if (!w) return;
  dismissNeeds(w);
  // Only a real dismissal holds: the menu offers it on cards not waiting too.
  if (!isNeedsDismissed(w)) return;
  const live = new Set((data.workspaces() ?? []).map((x) => x.id));
  for (const id of dismissedHold.keys()) if (!live.has(id)) dismissedHold.delete(id);
  dismissedHold.set(w.id, statusOf(w));
  bump();
}

function heldAtTop(w: Workspace): boolean {
  tick();
  const held = dismissedHold.get(w.id);
  if (held === undefined) return false;
  if (held === statusOf(w)) return true;
  dismissedHold.delete(w.id);
  return false;
}

/** Where a session in Needs you came from: its lane and marker, or its project group in Projects view. */
export function originOf(w: Workspace | undefined): { name: string; color: string } {
  if (!w) return { name: "", color: "clear" };
  // A lane's generated anchor is in no project group: it names its lane in both views.
  if (mode() === "projects" && !laneAnchorIds().has(w.id)) {
    const p = projectByKey(projectKey(w));
    return { name: p.name, color: p.color };
  }
  const lane = laneByKey(laneOf(w));
  return { name: lane.name, color: lane.color };
}

// --- All mode: one flat list of lane headers and cards --------------------------------

// A header's key carries the anchor it shows (issue #49), and an empty lane
// is a zone (issue #50), since a row's kind is fixed by its key. A card's key
// is "w:" and its session, without its lane, so a lane move keeps its row
// (cards.ts's cardFor). A session in the Needs you strip leaves a
// placeholder, keyed "g:" and its session.
export type LaneEntry =
  | { kind: "header"; id: string; lane: LaneKey; anchorId: string | null }
  | { kind: "zone"; id: string; lane: LaneKey }
  | { kind: "ws"; id: string; wsId: string; lane: LaneKey }
  | { kind: "ghost"; id: string; wsId: string; lane: LaneKey };

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

function liveRank(w: Workspace | undefined): number {
  const s = statusOf(w);
  if (s === "needs_input") {
    if (w) dismissedHold.delete(w.id);
    return 0;
  }
  if (w && heldAtTop(w)) return 0;
  if (isReady(w)) return 1;
  return s === "working" ? 2 : 3;
}

// The rank each card last had while not selected. Opening a Ready card
// clears its Ready state (status.ts), and answering a card moves it on, so
// the selected card keeps the best of that rank and its live one: it never
// slides out from under the pointer, and it settles once Jon moves on.
// Written during render and read only for the selected card, so no bump().
const heldRank = new Map<string, number>();

/** A card's place in its lane (issue #74): needs you, then Ready, then working, then the rest. */
export function stateRank(w: Workspace | undefined): number {
  const rank = liveRank(w);
  if (!w) return rank;
  if (!isSelected(w)) {
    heldRank.set(w.id, rank);
    return rank;
  }
  return Math.min(rank, heldRank.get(w.id) ?? rank);
}

// Array sort is stable, so cards in the same state keep the tab order Jon
// dragged them into; drop.ts anchors a drop to a card in the same state so it
// lands where he let go.
function byState(rows: Workspace[]): Workspace[] {
  const rank = new Map(rows.map((w) => [w.id, stateRank(w)]));
  return rows.sort((a, b) => (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0));
}

const laneSections = computed((): LaneSection[] => {
  const all = cards();
  return LANES.map((lane) => ({
    lane,
    rows: byState(all.filter((w) => laneOf(w) === lane.key)),
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
  const waiting = inStrip();
  return [
    header,
    ...s.rows.map(
      (w): LaneEntry =>
        waiting.has(w.id)
          ? { kind: "ghost", id: "g:" + w.id, wsId: w.id, lane: key }
          : { kind: "ws", id: "w:" + w.id, wsId: w.id, lane: key },
    ),
  ];
}

// An empty lane is a zone row in its own place, at rest and mid-drag alike,
// so the renderer's drop index always counts the same rows resolveDrop does.
const laneEntries = computed(() =>
  laneSections().flatMap((s): LaneEntry[] =>
    isEmpty(s) ? [{ kind: "zone", id: "z:" + s.lane.key, lane: s.lane.key }] : sectionEntries(s),
  ),
);

// Built in both modes: the lanes panel stays mounted under Projects, hidden
// (panelOpacity). drop.ts ignores a drag or move outside All instead.
export const flatEntries: () => LaneEntry[] = laneEntries;

// Lanes you come back to after a while, where a card also says what you last asked.
const LEFT_OFF_LANES: ReadonlySet<LaneKey> = new Set<LaneKey>(["bg", "parked"]);

/** Whether the card shows your last prompt: in Background and Parked, by cmux's own data as cardDensity is. */
export const showsLeftOff = (w: Workspace | undefined): boolean => LEFT_OFF_LANES.has(actualLaneOf(w));

/**
 * The cards a lane header counts, every card it lists, folded or not, and
 * the placeholders of those waiting in the Needs you strip. The header
 * filters once per change and reads its count, its pill's tint (status.ts
 * countColors) and, folded, its status dot from the one list.
 */
export const laneWorkspaces = (laneKey: LaneKey): Workspace[] => cards().filter((w) => laneOf(w) === laneKey);

/**
 * A lane header's merge line: "2 ready to merge" when that many of its
 * workspaces hold a PR GitHub would merge now (prs.ts's ready health), else
 * "". Every card the lane counts (laneWorkspaces), placeholders too, since
 * a waiting session's PR is still mergeable. The lane's generated
 * anchor counts as well: it has no card, and its status already sits on the
 * header.
 */
export function mergeReadyText(laneKey: LaneKey): string {
  const anchor = generatedAnchorId(laneByKey(laneKey));
  const ws = [...laneWorkspaces(laneKey), ...(anchor ? [wsById(anchor)] : [])];
  const n = ws.filter((w) => prHealth(w) === "ready").length;
  return n ? n + " ready to merge" : "";
}

// Ready's green (pr-colors.ts), so the count reads as the PR verdict, not
// the agent's Ready pill.

/** The words at a lane header's trailing edge, and their ink. */
export interface HeaderHint {
  text: string;
  color: string;
}

/**
 * "Drop here" while a drag is over the lane, else its merge line. Parked
 * keeps its merge line faint, as it does its title: set-aside work should
 * not call out in green.
 */
export function headerHint(laneKey: LaneKey, dropping: boolean): HeaderHint {
  if (dropping) return { text: "Drop here", color: C.heading };
  return { text: mergeReadyText(laneKey), color: laneKey === "parked" ? C.faint : READY_INK };
}

// --- Projects mode ---------------------------------------------------------------------
// PROJECTS order, then Other; empty projects are skipped. Grouped by project,
// not by match, so a project with several paths is one group. Collapse is
// local only: projects are not cmux groups.

const OTHER: Project = { match: "other", name: "Other", color: P.grey, icon: "terminal" };

export const projectKey = (w: Workspace): string => {
  tick();
  const p = projectFor(w.directory, projectOverride.get(w.id));
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
 * project unfolds first, so the new card is not hidden under its header. */
export function openProjectWorkspace(k: string, group?: WorkspaceGroup | null): void {
  const root = rootToOpen(k);
  if (!root) return;
  if (isProjectCollapsed(k)) toggleProject(k);
  cmux("workspace.create", group ? { cwd: root, focus: true, group_id: group.id } : { cwd: root, focus: true });
}

const openLabel = (k: string): string => `New session in ${projectByKey(k).name}`;

/** The card menu's new session label. Menu items are fixed when the card is
 * built, so a project with no folder says why instead of vanishing. */
export function newSessionLabel(w: Workspace | undefined): string {
  if (!w) return "New session (no workspace)";
  return projectNewLabel(projectKey(w));
}

/** Opens a new session in the card's project folder, a no-op without one.
 * It lands in Main activity, since Jon is about to work in it; with no
 * Main activity group yet it opens ungrouped. */
export function newSessionFor(w: Workspace | undefined): void {
  if (w) openProjectWorkspace(projectKey(w), groupForLane(laneByKey("main")));
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

// --- Card chips (issue #48) ------------------------------------------------------------

export type ChipId = "size" | "pr" | "br" | "port";

/** The PR chip: its number and its state words, each inked its own way. */
export interface PrChip {
  id: "pr";
  /** The number, "#135", drawn in the chip's own ink. */
  tag: string;
  /** The state words after the number ("draft", "1 failing"), in its health's ink; "" with none. */
  state: string;
  health: PrHealth;
  /** The diff size, "+120 −8", in faint ink after the state; "" with none. */
  diff: string;
  url?: string;
}

/** Every other chip: one line of words. */
export interface TextChip {
  id: Exclude<ChipId, "pr">;
  text: string;
  url?: string;
  /** The branch chip's uncommitted-changes dot. */
  dirty?: boolean;
  /** The size chip's size, which picks its ink. */
  size?: MoveSize;
}

export type Chip = PrChip | TextChip;

const isPort = (p: number): boolean => Number.isInteger(p) && p > 0 && p < 65536;

function portChip(ports: readonly number[] | undefined): TextChip | null {
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
  // First, so what answering takes reads before where the work is.
  const move = moveOf(w);
  const size = move ? moveSize(move) : null;
  if (move && size) out.push({ id: "size", text: moveSizeText(size, move.decisions), size });
  const pr = prSummary(w);
  if (pr) {
    const c: PrChip = { id: "pr", tag: pr.tag, state: pr.state, health: pr.health, diff: pr.diff };
    if (pr.url) c.url = pr.url;
    out.push(c);
  }
  if (withBranch && w.branch) out.push({ id: "br", text: w.branch, dirty: !!w.dirty });
  const port = portChip(w.ports);
  if (port) out.push(port);
  return out;
}

// Ready cards (issue #53).

/** Its PR is ready to merge (the green chip), so "To review" shows in green. */
export const reviewIsGreen = (w: Workspace | undefined): boolean => prHealth(w) === "ready";

/**
 * A Ready card, or one whose PR is ready to merge, offers "To review",
 * unless it is already in For review or anchors a group: a generated lane
 * anchor is its group, and a real workspace anchoring one cannot leave it
 * (drop.ts pins those too). A ready PR never files the card itself, so
 * this is the way in.
 */
export function canFileForReview(w: Workspace | undefined): boolean {
  return !!w && (isReady(w) || reviewIsGreen(w)) && laneOf(w) !== "review" && !isAnchor(w);
}

/** Files a card into For review. */
export const fileForReview = (w: Workspace | undefined): void => moveToLane(w, "review");
