// The editor under a project's header: one project open at a time, its
// draft held here until Done saves it in one go, so a whole edit costs one
// rebuild rather than one per tap. Any project can be edited, whether it came
// from config/projects.json or was made in the sidebar (issue #9).

import type { ProjectSpec } from "../../scripts/state-config.ts";
import { matchesOf, PROJECT_COLORS, PROJECT_ICONS, PROJECTS, projectId } from "../shared/projects.ts";
import { knownProjects, removeProject, saveProject, specOf } from "./model.ts";
import { editingProject, setEditingProject } from "./state.ts";

const [draft, setDraft] = signal<ProjectSpec>({ name: "", color: PROJECT_COLORS[0], icon: PROJECT_ICONS[0] });
// Remove asks twice: a project from the file cannot come back from the sidebar.
const [removing, setRemoving] = signal(false);

export const draftSpec = (): ProjectSpec => draft();

/** Opens the editor on the project as it now stands; a no-op for Other or a removed one. */
export function openEditor(k: string): void {
  const spec = specOf(k);
  if (!spec) return;
  setDraft({ ...spec });
  setRemoving(false);
  setEditingProject(k);
}

export function closeEditor(): void {
  setEditingProject(null);
  setRemoving(false);
}

export const setDraftName = (name: string): void => setDraft({ ...draft(), name });
export const setDraftColor = (color: string): void => setDraft({ ...draft(), color });
export const setDraftIcon = (icon: string): void => setDraft({ ...draft(), icon });

/** An empty folder clears it, so the header loses its "+". */
export function setDraftFolder(text: string): void {
  const { root: _old, ...rest } = draft();
  const root = text.trim();
  setDraft(root ? { ...rest, root } : rest);
}

const MAX_NAME = 64;
const MAX_FOLDER = 512;
const hasControl = (s: string): boolean => [...s].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127);
const isFolder = (s: string): boolean => s.startsWith("/") || s === "~" || s.startsWith("~/");

/** Why Done would not save, in words, or null when it would: the rules the state file holds. */
export function draftProblem(): string | null {
  const k = editingProject();
  const name = draft().name.trim();
  const root = draft().root;
  if (!name) return "Give the project a name.";
  if (name.length > MAX_NAME) return `Keep the name to ${MAX_NAME} characters.`;
  if (hasControl(name)) return "The name cannot hold tabs or line breaks.";
  if (knownProjects().some((p) => p.name === name && projectId(p) !== k)) return `Another project is called ${name}.`;
  if (root !== undefined && (!isFolder(root) || root.length > MAX_FOLDER || hasControl(root))) {
    return "The folder needs a full path, starting with / or ~/.";
  }
  return null;
}

const sameSpec = (a: ProjectSpec, b: ProjectSpec | undefined): boolean =>
  !!b && a.name === b.name && a.color === b.color && a.icon === b.icon && a.root === b.root;

/** Saves the draft and closes, or does nothing while draftProblem() has a reason. Unchanged, it only closes. */
export function saveDraft(): void {
  const k = editingProject();
  if (k === null || draftProblem()) return;
  const spec = { ...draft(), name: draft().name.trim() };
  if (!sameSpec(spec, specOf(k))) saveProject(k, spec);
  closeEditor();
}

export const removeLabel = (): string => (removing() ? "Tap again to remove" : "Remove project");

/** The first tap asks, the second removes. */
export function removeTapped(): void {
  const k = editingProject();
  if (k === null) return;
  if (!removing()) {
    setRemoving(true);
    return;
  }
  removeProject(k);
  closeEditor();
}

/** Which folders put a session in the project, for the line under the folder field. */
export function matchesLine(k: string): string {
  const p = PROJECTS.find((x) => projectId(x) === k);
  return "Sessions in " + (p ? matchesOf(p) : [k]).join(", ");
}
