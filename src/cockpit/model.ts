// Workspaces as the cockpit sees them: which lane each is in, tab order,
// lane folds and the view mode. strip.ts, lane-entries.ts, by-project.ts,
// next.ts and card-chips.ts build each mode's rows on top of this.
//
// Optimistic overrides flip locally the same frame, then clear once the data
// agrees or after OVERRIDE_SECS (so a normalised result from the app wins).

import type { ViewMode } from "../../scripts/state-config.ts";
import { isGeneratedAnchor } from "../shared/anchors.ts";
import { P } from "../shared/palette.ts";
import { persistSet } from "../shared/persist.ts";
import { isProjectKey, type Project, projectId } from "../shared/projects.ts";
import { nowEpoch } from "../shared/time.ts";
import { renameLaneGroups } from "./lane-rename.ts";
import { findLane, LANES, type Lane, type LaneKey, laneByKey, UNSORTED_KEY } from "./lanes.ts";
import {
  bump,
  collapsedProjects,
  isMode,
  mode,
  OVERRIDE_SECS,
  quietCollapsed,
  savedFolds,
  setMode,
  setUnsortedCollapsed,
  tick,
  unsortedCollapsed,
} from "./state.ts";

// --- groups and lanes ---------------------------------------------------------------

export const groups = (): WorkspaceGroup[] => data.groups() ?? [];

/** A workspace anchoring a group: it cannot leave it (drop.ts pins it), and closing it would take the lane. */
export const isAnchor = (w: Workspace): boolean => groups().some((g) => g.anchorId === w.id);

export const groupForLane = (lane: Lane): WorkspaceGroup | null =>
  lane.key === UNSORTED_KEY ? null : (groups().find((g) => g.name === lane.name) ?? null);

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
export function generatedAnchorId(lane: Lane): string | null {
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
  if (!w?.group) return UNSORTED_KEY;
  for (const lane of LANES) {
    const g = groupForLane(lane);
    if (g && g.id === w.group) return lane.key;
  }
  return UNSORTED_KEY;
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
  const lane = findLane(laneKey);
  if (!w || !lane || laneAnchorIds().has(w.id)) return;
  if (actualLaneOf(w) === laneKey) {
    if (laneOverride.delete(w.id)) bump();
    return;
  }
  const g = groupForLane(lane);
  if (laneKey === UNSORTED_KEY) cmux("workspace.group.remove", { workspace_id: w.id });
  else if (g) cmux("workspace.group.add", { group_id: g.id, workspace_id: w.id });
  else requestLaneGroup(lane);
  laneOverride.set(w.id, { lane: laneKey, at: nowEpoch(), awaiting: laneKey !== UNSORTED_KEY && !g });
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
// --- order ---------------------------------------------------------------------------

let orderOverride: { ids: string[]; at: number } | null = null;

/** Records a reorder the app has not reflected yet. */
export function overrideOrder(ids: string[]): void {
  orderOverride = { ids, at: nowEpoch() };
  bump();
}

export function allWorkspaces(): Workspace[] {
  tick();
  renameLaneGroups();
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

/** Real cards, memoised once per change for every lane and project header that filters them. */
export const cards = computed(cardWorkspaces);

// Other: the group for a card no project matches. Here, not in by-project.ts, since saveFolds keeps its fold.
export const OTHER: Project = { match: "other", name: "Other", color: P.grey, icon: "terminal" };

// --- lane collapse -------------------------------------------------------------------

const collapseOverride = new Map<string, boolean>(); // groupId -> collapsed
// A lane with a saved flag has been toggled before, so its `folded` no
// longer applies to it after a reload.
const touchedLanes = new Set<LaneKey>(LANES.filter((l) => `lane:${l.key}` in savedFolds).map((l) => l.key));

export function isCollapsed(lane: Lane): boolean {
  tick();
  if (lane.key === UNSORTED_KEY) return unsortedCollapsed();
  const g = groupForLane(lane);
  if (!g) return false;
  const v = collapseOverride.get(g.id);
  if (v !== undefined) {
    if (v === g.collapsed) collapseOverride.delete(g.id);
    else return v;
  }
  if (lane.folded && !touchedLanes.has(lane.key)) return true;
  return !!g.collapsed;
}

export function toggleLane(lane: Lane): void {
  const next = !isCollapsed(lane);
  touchedLanes.add(lane.key);
  if (lane.key === UNSORTED_KEY) {
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

// The saved folds of lanes lanes.json no longer holds, kept as they were.
const goneLaneFolds = (): [string, number][] =>
  Object.entries(savedFolds).filter(([k]) => k.startsWith("lane:") && !findLane(k.slice("lane:".length)));

// Sends every fold at once, so the saved copy never lags a quick second tap.
// cmux holds a lane group's own fold; its flag marks it as touched, and only
// Unsorted's value is read back. The Quiet header saves only while folded. Folds on projects that are gone are dropped,
// but a lane taken out of lanes.json keeps its saved fold, so putting it back brings the fold too.
// Keys are sorted so the same folds always write the same file.
export function saveFolds(): void {
  const folds: [string, number][] = [];
  for (const lane of LANES) if (touchedLanes.has(lane.key)) folds.push([`lane:${lane.key}`, isCollapsed(lane) ? 1 : 0]);
  folds.push(...goneLaneFolds());
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
