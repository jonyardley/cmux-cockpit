// Author state: local to this sidebar. The view and the folds are seeded from
// the saved state, since every rebuild reloads the sidebar; model.ts saves them.

import type { ViewMode } from "../../scripts/state-config.ts";
import { SAVED_STATE } from "../shared/persist.ts";
import { nowEpoch } from "../shared/time.ts";

/** Saved fold flags: "lane:<key>", "project:<key>" or "quiet" -> 1 folded, 0 unfolded. */
export const savedFolds: Readonly<Record<string, number>> = SAVED_STATE.ui.collapsed ?? {};

const PROJECT_FOLD = "project:";

/** How long an optimistic override holds before cmux's own data wins. */
export const OVERRIDE_SECS = 4;

// View mode: "all" (lanes) or "projects" (cards grouped by project, not lane).
export const [mode, setMode] = signal<ViewMode>(SAVED_STATE.ui.mode ?? "all");
/** A live check that `m` is the chosen mode, shared by the tab and its panel. */
export const isMode = (m: ViewMode) => (): boolean => mode() === m;
export const projectsMode = isMode("projects");

export const [unsortedCollapsed, setUnsortedCollapsed] = signal(savedFolds["lane:unsorted"] === 1);
export const [quietCollapsed, setQuietCollapsed] = signal(savedFolds.quiet === 1);
export const [collapsedProjects, setCollapsedProjects] = signal<string[]>(
  Object.entries(savedFolds)
    .filter(([k, flag]) => k.startsWith(PROJECT_FOLD) && flag === 1)
    .map(([k]) => k.slice(PROJECT_FOLD.length)),
);
export const [drag, setDrag] = signal<DragState | null>(null);
/** The project whose editor is open under its header, if any (src/cockpit/edit.ts). */
export const [editingProject, setEditingProject] = signal<string | null>(null);
/** The editor's key while it makes a new project: no project key starts with "+". */
export const NEW_PROJECT = "+new";

// Plain Maps and lets are not reactive: code that reads them calls tick(),
// and code that writes them calls bump(), so dependents recompute.
export const [tick, setTick] = signal(0);
export const bump = () => setTick(tick() + 1);

// Selection, applied at once: a tapped card reads as selected (and loses
// its Ready state) the same frame, before cmux publishes the change. Lives
// here, not in model.ts, so status.ts can read it without an import cycle.
// Like the other overrides it lapses after OVERRIDE_SECS, so a select cmux
// refused or never published cannot pin the highlight to that card.
let selectOverride: { id: string; at: number } | null = null;

export function isSelected(w: Workspace | undefined): boolean {
  tick();
  if (!w) return false;
  if (selectOverride) {
    const { id, at } = selectOverride;
    if (data.selectedId() === id || nowEpoch() - at > OVERRIDE_SECS) selectOverride = null;
    else return w.id === id;
  }
  return !!w.selected;
}

export function selectWorkspace(id: string | undefined): void {
  if (!id) return;
  selectOverride = { id, at: nowEpoch() };
  bump();
  cmux("workspace.select", { workspace_id: id });
}
