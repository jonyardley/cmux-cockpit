// Validates the project table before the build injects it (see build.ts).
// Kept apart from build.ts so the rules can be tested without running a build.

import { isRemoved, type ProjectSpec, type SavedProject } from "./state-config.ts";

export interface Project {
  match: string | string[];
  name: string;
  color: string;
  icon: string;
  /** Absolute path (`~` allowed) to open a new workspace in. Optional. */
  root?: string;
  /** Set by mergeProjects on a project that came from the file, so removing it saves a removal. */
  seeded?: true;
}

export type ProjectsResult = { ok: true; projects: readonly Project[] } | { ok: false; error: string };

// Directories are lowercased before matching, so a match with capitals never hits.
function isMatchString(value: unknown): value is string {
  return typeof value === "string" && value !== "" && value === value.toLowerCase();
}

// One path fragment, or a non-empty list of them.
function isMatch(value: unknown): value is string | string[] {
  if (isMatchString(value)) return true;
  return Array.isArray(value) && value.length > 0 && value.every(isMatchString);
}

// Absolute, or exactly `~` or `~/...` (what build.ts's expandRoot actually expands); unlike
// match this keeps its case and is not a fragment. A bare "~jon/..." would reach the sidebar
// unexpanded, so it is rejected here rather than passed through.
function isRoot(value: unknown): value is string {
  return (
    typeof value === "string" && value !== "" && (value.startsWith("/") || value === "~" || value.startsWith("~/"))
  );
}

function isProject(value: unknown): value is Project {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (!isMatch(v.match) || typeof v.name !== "string" || typeof v.color !== "string" || typeof v.icon !== "string") {
    return false;
  }
  return v.root === undefined || isRoot(v.root);
}

const matchList = (p: Project): string[] => (typeof p.match === "string" ? [p.match] : p.match);

/** The first value seen twice, if any. */
function firstDuplicate(values: readonly string[]): string | undefined {
  const seen = new Set<string>();
  for (const v of values) {
    if (seen.has(v)) return v;
    seen.add(v);
  }
  return undefined;
}

/** Checks shape, then that project ids (first match) and names are unique. */
export function validateProjects(parsed: unknown): ProjectsResult {
  if (!Array.isArray(parsed) || !parsed.every(isProject)) {
    return {
      ok: false,
      error:
        "must be a JSON array of { match, name, color, icon, root? } strings; match is a non-empty lowercase" +
        " string or a list of them, root (if given) is a non-empty absolute path starting with / or ~",
    };
  }
  const projects: readonly Project[] = parsed;
  const id = firstDuplicate(projects.map((p) => matchList(p)[0] ?? ""));
  if (id !== undefined) return { ok: false, error: `two projects share the first match "${id}"` };
  const name = firstDuplicate(projects.map((p) => p.name));
  if (name !== undefined) {
    return { ok: false, error: `two projects are named "${name}"; give one project several matches instead` };
  }
  return { ok: true, projects };
}

export interface Merged {
  projects: readonly Project[];
  /** The saved entries that made it in, removals included, so the sidebar edits from what it saved. */
  kept: Record<string, SavedProject>;
}

const idOf = (p: Project): string => matchList(p)[0] ?? "";

// A file project with its saved edit laid over. Its matches stay: a fragment
// such as "/.config/cmux" also catches that folder's worktrees, and a saved
// key could not say so.
function edited(p: Project, spec: ProjectSpec): Project {
  const { root: _root, ...rest } = p;
  return { ...rest, name: spec.name, color: spec.color, icon: spec.icon, ...(spec.root ? { root: spec.root } : {}) };
}

function withEdits(file: readonly Project[], edits: ReadonlyMap<string, SavedProject>): Project[] {
  return file.flatMap((p) => {
    const edit = edits.get(idOf(p));
    if (edit && isRemoved(edit)) return [];
    return [{ ...(edit ? edited(p, edit) : p), seeded: true as const }];
  });
}

// The edited file projects whose name another project also has.
function clashing(projects: readonly Project[], edits: ReadonlyMap<string, SavedProject>): string[] {
  const count = new Map<string, number>();
  for (const p of projects) count.set(p.name, (count.get(p.name) ?? 0) + 1);
  return projects.filter((p) => (count.get(p.name) ?? 0) > 1 && edits.has(idOf(p))).map(idOf);
}

/**
 * The file's table with the saved projects (issue #9) laid over it. A saved
 * entry under a file project's first match edits or removes that project, so
 * every project can be changed in the sidebar and the file is only the seed.
 * An edit that would give two projects one name is dropped, the file's entry
 * kept. The rest are sidebar-made projects, appended; one whose folder a file
 * match already claims, or whose name is taken, is dropped, so it can never
 * sit as an empty header nobody can reach. Deeper folders go first, since
 * projectOf takes the first match. The result always passes validateProjects.
 */
export function mergeProjects(file: readonly Project[], saved: Record<string, SavedProject>): Merged {
  const ids = new Set(file.map(idOf));
  const edits = new Map(Object.entries(saved).filter(([id]) => ids.has(id)));
  let projects = withEdits(file, edits);
  for (let clash = clashing(projects, edits); clash.length; clash = clashing(projects, edits)) {
    for (const id of clash) edits.delete(id);
    projects = withEdits(file, edits);
  }
  const kept: Record<string, SavedProject> = Object.fromEntries(edits);
  const fileMatches = file.flatMap(matchList);
  const matches = new Set(fileMatches);
  const names = new Set(projects.map((p) => p.name));
  const deepestFirst = Object.entries(saved).sort(([a], [b]) => b.length - a.length);
  for (const [match, spec] of deepestFirst) {
    // A key with no trailing "/" is only ever a file project's; with that project gone, it is dropped.
    if (ids.has(match) || isRemoved(spec) || !match.endsWith("/")) continue;
    if (matches.has(match) || names.has(spec.name) || fileMatches.some((m) => match.includes(m))) continue;
    matches.add(match);
    names.add(spec.name);
    projects.push({ match, ...spec });
    kept[match] = spec;
  }
  return { projects, kept };
}
