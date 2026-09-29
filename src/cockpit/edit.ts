// The editor under a project's header: one project open at a time, its
// draft held here until Done saves it in one go, so a whole edit costs one
// rebuild rather than one per tap. Any project can be edited, whether it came
// from config/projects.json or was made in the sidebar (issue #9).

import type { ProjectSpec } from "../../scripts/state-config.ts";
import { isHex, isMatchKey, isName, isRoot, isSymbol, MAX_NAME } from "../shared/project-rules.ts";
import { matchesOf, PROJECT_COLORS, PROJECT_ICONS, PROJECTS, projectId } from "../shared/projects.ts";
import { SYMBOLS } from "../shared/symbols.ts";
import { knownProjects, removeProject, saveProject, specOf } from "./model.ts";
import { editingProject, setEditingProject } from "./state.ts";

const [draft, setDraft] = signal<ProjectSpec>({ name: "", color: PROJECT_COLORS[0], icon: PROJECT_ICONS[0] });
// Remove asks twice: a project from the file cannot come back from the sidebar.
const [removing, setRemoving] = signal(false);
// The icon search's words. Read only inside closures, so typing redraws the
// picker's rows and not the whole editor.
const [iconQuery, setIconQuery] = signal("");

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
  setIconQuery("");
  setEditingProject(k);
}

export function closeEditor(): void {
  setEditingProject(null);
  setRemoving(false);
}

export const setDraftName = (name: string): void => setDraft({ ...draft(), name });
export const setDraftColor = (color: string): void => setDraft({ ...draft(), color });
export const setDraftIcon = (icon: string): void => setDraft({ ...draft(), icon });
export const iconSearch = (): string => iconQuery();
export const setIconSearch = (text: string): void => setIconQuery(text);

/** Return in the search: picks its first match and keeps the editor open, so Return never saves the old icon. */
export function pickFirstMatch(): void {
  const first = iconMatches(iconQuery())[0];
  if (first) setDraftIcon(first);
}

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

const ICONS_PER_ROW = 8;
const MAX_MATCHES = 2 * ICONS_PER_ROW;

/**
 * The common row: PROJECT_ICONS, still one row. A project whose icon is not
 * one of them (set in projects.json, or found by search) gets it as the
 * first choice, so it shows selected and can be picked again.
 */
export function commonIcons(current: string): string[] {
  const known: readonly string[] = PROJECT_ICONS;
  if (known.includes(current) || !isSymbol(current)) return [...known];
  return [current, ...known.slice(0, ICONS_PER_ROW - 1)];
}

/**
 * The stored symbols holding every word typed, as many as two rows take.
 * Words match across the dots, so "music note" finds music.note.
 */
export function iconMatches(query: string): string[] {
  const words = query
    .toLowerCase()
    .split(/[\s.]+/)
    .filter(Boolean);
  if (!words.length) return [];
  return SYMBOLS.filter((n) => words.every((w) => n.includes(w))).slice(0, MAX_MATCHES);
}

/** The picker's rows, eight to a row: the common row while the search is empty, else its matches. */
export function iconRows(current: string, query: string = iconQuery()): string[][] {
  const icons = query.trim() ? iconMatches(query) : commonIcons(current);
  const rows: string[][] = [];
  for (let i = 0; i < icons.length; i += ICONS_PER_ROW) rows.push(icons.slice(i, i + ICONS_PER_ROW));
  return rows;
}

/** The line under the search when it finds nothing, or "" while it finds something or is empty. */
export const noMatchLine = (query: string = iconQuery()): string =>
  query.trim() && !iconMatches(query).length ? `No icons match "${query.trim()}".` : "";
