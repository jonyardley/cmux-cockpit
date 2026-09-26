// Author state: local to this sidebar, forgotten on reload.

// View mode: "all" (lanes) or "projects" (cards grouped by project, not lane).
export type Mode = "all" | "projects";
export const [mode, setMode] = signal<Mode>("all");
export const projectsMode = () => mode() === "projects";

export const [unsortedCollapsed, setUnsortedCollapsed] = signal(false);
export const [collapsedProjects, setCollapsedProjects] = signal<string[]>([]);
export const [drag, setDrag] = signal<DragState | null>(null);

// Plain Maps and lets are not reactive: code that reads them calls tick(),
// and code that writes them calls bump(), so dependents recompute.
export const [tick, setTick] = signal(0);
export const bump = () => setTick(tick() + 1);
