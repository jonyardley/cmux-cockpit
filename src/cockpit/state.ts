// Author state: local to this sidebar. The view and the folds are seeded from
// the saved state, since every rebuild reloads the sidebar; model.ts saves them.

import type { ViewMode } from "../../scripts/state-config.ts";
import { SAVED_STATE } from "../shared/persist.ts";

/** Saved fold flags: "lane:<key>", "project:<key>" or "quiet" -> 1 folded, 0 unfolded. */
export const savedFolds: Readonly<Record<string, number>> = SAVED_STATE.ui.collapsed ?? {};

const PROJECT_FOLD = "project:";

// View mode: "all" (lanes) or "projects" (cards grouped by project, not lane).
export const [mode, setMode] = signal<ViewMode>(SAVED_STATE.ui.mode ?? "all");
export const projectsMode = () => mode() === "projects";

export const [unsortedCollapsed, setUnsortedCollapsed] = signal(savedFolds["lane:unsorted"] === 1);
export const [quietCollapsed, setQuietCollapsed] = signal(savedFolds.quiet === 1);
export const [collapsedProjects, setCollapsedProjects] = signal<string[]>(
  Object.entries(savedFolds)
    .filter(([k, flag]) => k.startsWith(PROJECT_FOLD) && flag === 1)
    .map(([k]) => k.slice(PROJECT_FOLD.length)),
);
export const [drag, setDrag] = signal<DragState | null>(null);

// Plain Maps and lets are not reactive: code that reads them calls tick(),
// and code that writes them calls bump(), so dependents recompute.
export const [tick, setTick] = signal(0);
export const bump = () => setTick(tick() + 1);
