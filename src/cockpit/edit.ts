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
  // Opening the open project again keeps its rows, and with them the
  // search box's text, so the search stays to match.
  if (editingProject() !== k) setIconQuery("");
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

/** An empty folder clears it, so the header loses its "+". */
export function setDraftFolder(text: string): void {
  const { root: _old, ...rest } = draft();
  const root = text.trim();
  setDraft(root ? { ...rest, root } : rest);
}

/** Escape in the search: with words typed it does nothing, so the draft is not lost; empty, it closes as Cancel does. */
export function cancelSearch(): void {
  if (!iconQuery().trim()) closeEditor();
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

export const ICONS_PER_ROW = 8;
const MAX_MATCHES = 2 * ICONS_PER_ROW;

/** `list` cut into rows of `n`, the last one short. */
export function rowsOf<T>(list: readonly T[], n: number): T[][] {
  const rows: T[][] = [];
  for (let i = 0; i < list.length; i += n) rows.push(list.slice(i, i + n));
  return rows;
}

/**
 * The common row: PROJECT_ICONS, always one row. A project whose icon is
 * not one of them (set in projects.json, or found by search) gets it as the
 * first choice, so it shows selected and can be picked again; the last
 * common icon gives up its place.
 */
export function commonIcons(current: string): string[] {
  const known: readonly string[] = PROJECT_ICONS;
  if (known.includes(current) || !isSymbol(current)) return [...known];
  return [current, ...known.slice(0, ICONS_PER_ROW - 1)];
}

const wordsOf = (query: string): string[] =>
  query
    .toLowerCase()
    .split(/[\s.]+/)
    .filter(Boolean);

// Every word starts one of the name's dotted parts: "cat" is cat.fill, not location.fill.
const startsParts = (name: string, words: string[]): boolean => {
  const parts = name.split(".");
  return words.every((w) => parts.some((p) => p.startsWith(w)));
};

/**
 * Every stored symbol holding each word typed, across the dots, so "music
 * note" finds music.note. Names whose parts start with the words come first.
 */
function allMatches(query: string): string[] {
  const words = wordsOf(query);
  if (!words.length) return [];
  const hits = SYMBOLS.filter((n) => words.every((w) => n.includes(w)));
  return [...hits.filter((n) => startsParts(n, words)), ...hits.filter((n) => !startsParts(n, words))];
}

/** The matches the picker shows: as many as two rows take. */
export const iconMatches = (query: string): string[] => allMatches(query).slice(0, MAX_MATCHES);

// Worked out once per keystroke, for the rows and the line under them.
const searchHits = computed(() => allMatches(iconQuery()));

/** The picker's rows, eight to a row: the common row while the search is empty, else its matches. */
export function iconRows(current: string, query: string = iconQuery()): string[][] {
  const hits = query === iconQuery() ? searchHits() : allMatches(query);
  return rowsOf(query.trim() ? hits.slice(0, MAX_MATCHES) : commonIcons(current), ICONS_PER_ROW);
}

/** The line under the rows: none found, or how many more a longer word would reach; "" otherwise. */
export function searchNote(query: string = iconQuery()): string {
  if (!query.trim()) return "";
  const n = (query === iconQuery() ? searchHits() : allMatches(query)).length;
  if (!n) return `No icons match "${query.trim()}".`;
  return n > MAX_MATCHES ? `${n - MAX_MATCHES} more: type more of the name.` : "";
}
