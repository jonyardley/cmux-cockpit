// Validates the project table before the build injects it (see build.ts).
// Kept apart from build.ts so the rules can be tested without running a build.

import type { ProjectSpec } from "./state-config.ts";

export interface Project {
  match: string | string[];
  name: string;
  color: string;
  icon: string;
  /** Absolute path (`~` allowed) to open a new workspace in. Optional. */
  root?: string;
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
  /** The sidebar-made projects that made it in, so the sidebar knows which it may edit. */
  kept: Record<string, ProjectSpec>;
}

/**
 * Appends the sidebar-made projects (issue #9) to the file's table. The file
 * wins: an in-app project whose folder a file match already claims, or whose
 * name is taken, is dropped, so it can never sit as an empty header nobody
 * can reach, and the merged table always passes validateProjects. Deeper
 * folders go first, since projectOf takes the first match.
 */
export function mergeProjects(file: readonly Project[], inApp: Record<string, ProjectSpec>): Merged {
  const fileMatches = file.flatMap(matchList);
  const matches = new Set(fileMatches);
  const names = new Set(file.map((p) => p.name));
  const projects: Project[] = [...file];
  const kept: Record<string, ProjectSpec> = {};
  const deepestFirst = Object.entries(inApp).sort(([a], [b]) => b.length - a.length);
  for (const [match, spec] of deepestFirst) {
    if (matches.has(match) || names.has(spec.name) || fileMatches.some((m) => match.includes(m))) continue;
    matches.add(match);
    names.add(spec.name);
    projects.push({ match, ...spec });
    kept[match] = spec;
  }
  return { projects, kept };
}
