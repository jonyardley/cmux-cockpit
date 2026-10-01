// The editor under a project's header: one project open at a time, its
// draft held here until Done saves it in one go, so a whole edit costs one
// rebuild rather than one per tap. Any project can be edited, whether it came
// from config/projects.json or was made in the sidebar (issue #9).

import type { ProjectSpec } from "../../scripts/state-config.ts";
import { expandHome, isHome, tildeHome } from "../shared/home.ts";
import { isHex, isMatchKey, isName, isRoot, isSymbol, MAX_NAME, MAX_PROJECT_KEY } from "../shared/project-rules.ts";
import {
  matchesOf,
  newProject,
  nextColor,
  PROJECT_COLORS,
  PROJECT_ICONS,
  PROJECTS,
  type Project,
  projectId,
} from "../shared/projects.ts";
import { SYMBOLS } from "../shared/symbols.ts";
import { knownProjects, openFolderOnce, removeProject, saveProject, specOf } from "./by-project.ts";
import { editingProject, NEW_PROJECT, setEditingProject } from "./state.ts";

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

/** Whether the open editor is making a new project rather than editing one. */
export const isNewDraft = (): boolean => editingProject() === NEW_PROJECT;

/** Opens the editor blank, in the next free colour, to make a project from a folder; a second tap closes it. */
export function openNewProject(): void {
  if (isNewDraft()) {
    closeEditor();
    return;
  }
  setDraft({ name: "", color: nextColor(knownProjects()), icon: PROJECT_ICONS[0] });
  setRemoving(false);
  setIconQuery("");
  setEditingProject(NEW_PROJECT);
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

/** An empty folder clears it, so the header loses its "+". A new project takes its name from the folder. */
export function setDraftFolder(text: string): void {
  const { root: _old, ...rest } = draft();
  const root = text.trim();
  const named = isNewDraft() ? { ...rest, name: madeFrom(root)?.spec.name ?? "" } : rest;
  setDraft(root ? { ...named, root } : named);
}

type Made = NonNullable<ReturnType<typeof newProject>>;
// A folder's check: the project it would make, or why it cannot, in words.
type FolderCheck = { made: Made } | { problem: string };

// The typed folder, "~" expanded once: missing, not a full path, or home.
function pathProblem(root: string): { dir: string } | { problem: string } {
  if (!root.trim()) return { problem: "Type the project's folder." };
  const dir = expandHome(root);
  if (dir === null || !dir.startsWith("/")) return { problem: "Type the folder's full path, starting with / or ~/." };
  if (isHome(dir)) return { problem: "That is your home folder: pick one inside it, such as ~/dev/app." };
  return { dir };
}

// Where a project matches: every match of a built one, else its key.
const matchesFor = (p: Project): readonly string[] => {
  const built = PROJECTS.find((x) => projectId(x) === projectId(p));
  return built ? matchesOf(built) : matchesOf(p);
};

// A known project's folder, "~" expanded and lowercased, ending in "/"; "" without one.
const rootKey = (p: Project): string => {
  const dir = p.root ? expandHome(p.root) : null;
  return dir ? dir.toLowerCase().replace(/\/*$/, "/") : "";
};

// The project already holding the folder, or one the folder would swallow.
// Known projects count those sent but not built, and not those removed.
function overlapProblem(made: Made): string | null {
  const d = made.key;
  const known = knownProjects();
  const owner = known.find((p) => matchesFor(p).some((m) => d.includes(m)));
  if (owner) return `That folder is already in ${owner.name}.`;
  const inside = known.find((p) => [...matchesFor(p), rootKey(p)].some((m) => m !== d && m.startsWith(d)));
  if (inside)
    return `${tildeHome(made.spec.root ?? "")} holds other projects, such as ${inside.name}: pick a folder inside it.`;
  return null;
}

// One check for the editor's words, Done and a suggested folder.
function checkFolder(root: string): FolderCheck {
  const path = pathProblem(root);
  if ("problem" in path) return path;
  const made = newProject(path.dir, knownProjects());
  if (!made) return { problem: "Pick a folder at least two levels deep, such as ~/dev/app." };
  if (!isMatchKey(made.key)) return { problem: `Keep the folder's path under ${MAX_PROJECT_KEY} characters.` };
  const overlap = overlapProblem(made);
  return overlap ? { problem: overlap } : { made };
}

// The project a typed folder would make, "~" expanded; null when it cannot make one.
function madeFrom(root: string): Made | null {
  const check = checkFolder(root);
  return "made" in check ? check.made : null;
}

// A new project's folder, in words, or null when it would save.
function newFolderProblem(root: string): string | null {
  const check = checkFolder(root);
  return "problem" in check ? check.problem : null;
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
  const folder = isNewDraft() ? newFolderProblem(root ?? "") : null;
  if (folder) return folder;
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
  if (k === NEW_PROJECT) {
    saveNew();
    return;
  }
  const spec = { ...draft(), name: draft().name.trim() };
  if (!sameSpec(spec, specOf(k))) saveProject(k, spec);
  closeEditor();
}

// Saved under the folder's own key, its "~" expanded, then a workspace opens
// there unless one is open already.
function saveNew(): void {
  const made = madeFrom(draft().root ?? "");
  if (!made) return;
  const { color, icon, name } = draft();
  saveProject(made.key, { ...made.spec, color, icon, name: name.trim() });
  closeEditor();
  if (made.spec.root) openFolderOnce(made.spec.root);
}

/** A suggested folder, one tap: saved in the draft's colour and icon, named after the folder. Its workspace is already open. */
export function addSuggested(dir: string): void {
  const made = madeFrom(dir);
  if (!made) return;
  saveProject(made.key, { ...made.spec, color: draft().color, icon: draft().icon });
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
const capped = (hits: string[]): string[] => hits.slice(0, MAX_MATCHES);
export const iconMatches = (query: string): string[] => capped(allMatches(query));

// Worked out once per keystroke, for the rows and the line under them.
const searchHits = computed(() => allMatches(iconQuery()));

/** The picker's rows, eight to a row: the common row while the search is empty, else its matches. */
export function iconRows(current: string, query: string = iconQuery()): string[][] {
  const hits = query === iconQuery() ? searchHits() : allMatches(query);
  return rowsOf(query.trim() ? capped(hits) : commonIcons(current), ICONS_PER_ROW);
}

/** The line under the rows: none found, or how many more a longer word would reach; "" otherwise. */
export function searchNote(query: string = iconQuery()): string {
  if (!query.trim()) return "";
  const n = (query === iconQuery() ? searchHits() : allMatches(query)).length;
  if (!n) return `No icons match "${query.trim()}".`;
  return n > MAX_MATCHES ? `${n - MAX_MATCHES} more: type more of the name.` : "";
}
