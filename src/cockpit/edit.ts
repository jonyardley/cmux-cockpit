// The editor under a project's header: one project open at a time, its
// draft held here until Done saves it in one go, so a whole edit costs one
// rebuild rather than one per tap. Any project can be edited, whether it came
// from config/projects.json or was made in the sidebar (issue #9).

import type { ProjectSpec } from "../../scripts/state-config.ts";
import { isHex, isMatchKey, isName, isRoot, isSymbol, MAX_NAME } from "../shared/project-rules.ts";
import { matchesOf, PROJECT_COLORS, PROJECT_ICONS, PROJECTS, projectId } from "../shared/projects.ts";
import { knownProjects, removeProject, saveProject, specOf } from "./model.ts";
import { editingProject, setEditingProject } from "./state.ts";

const [draft, setDraft] = signal<ProjectSpec>({ name: "", color: PROJECT_COLORS[0], icon: PROJECT_ICONS[0] });
// Remove asks twice: a project from the file cannot come back from the sidebar.
const [removing, setRemoving] = signal(false);

export const draftSpec = (): ProjectSpec => draft();

/**
 * Whether a project can be saved from the sidebar: its first match is the
 * key it saves under, and the state file refuses one shorter than two
 * segments (a projects.json match such as "applet").
 */
export const canSaveProject = (k: string): boolean => isMatchKey(k);

/** The project menu's edit item: what it opens, or why it opens nothing. */
export const editLabel = (k: string): string =>
  canSaveProject(k) ? "Edit project" : "Edit project (its first match is too short to save)";

/** Opens the editor on the project as it now stands; a no-op for Other, a removed one, or one that cannot save. */
export function openEditor(k: string): void {
  const spec = canSaveProject(k) ? specOf(k) : undefined;
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

// The name is trimmed first, so the state file's rule fails it only on
// length or a control character; each gets its own words.
function nameProblem(name: string): string | null {
  if (!name) return "Give the project a name.";
  if (name.length > MAX_NAME) return `Keep the name to ${MAX_NAME} characters.`;
  if (!isName(name)) return "The name cannot hold tabs or line breaks.";
  const k = editingProject();
  if (knownProjects().some((p) => p.name === name && projectId(p) !== k)) return `Another project is called ${name}.`;
  return null;
}

/** Why Done would not save, in words, or null when it would: the rules the state file holds (src/shared/project-rules.ts). */
export function draftProblem(): string | null {
  const { name, color, icon, root } = draft();
  const named = nameProblem(name.trim());
  if (named) return named;
  if (!isHex(color)) return "Pick a colour from the dots.";
  if (!isSymbol(icon)) return "Pick an icon.";
  if (root !== undefined && !isRoot(root)) return "The folder needs a full path, starting with / or ~/.";
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

const ICONS_PER_ROW = 6;

/**
 * The icon picker's rows, at most six to a row so they fit the sidebar. A
 * project whose icon is not one of PROJECT_ICONS (set in projects.json) gets
 * it as the first choice, so it shows selected and can be picked again.
 */
export function iconRows(current: string): string[][] {
  const known: readonly string[] = PROJECT_ICONS;
  const icons = known.includes(current) || !isSymbol(current) ? [...known] : [current, ...known];
  const rows: string[][] = [];
  for (let i = 0; i < icons.length; i += ICONS_PER_ROW) rows.push(icons.slice(i, i + ICONS_PER_ROW));
  return rows;
}
