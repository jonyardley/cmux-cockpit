// Project identity from the workspace directory (brief: Look table).
// The table itself is not committed: scripts/build.ts injects it from
// config/projects.json (or the example table) as this define.

declare const __PROJECTS__: readonly Project[];

export interface Project {
  /** Path fragment, or several, any of which puts a directory in this project. */
  match: string | readonly string[];
  name: string;
  color: string;
  /** SF Symbol name. */
  icon: string;
  /** Absolute path (build.ts expands a leading `~`) to open a new workspace in. */
  root?: string;
}

export const PROJECTS: readonly Project[] = __PROJECTS__;

const NO_PROJECT: Project = { match: "", name: "", color: "#A09E95", icon: "terminal" };

/** Every path fragment the project matches, one or many. */
export function matchesOf(p: Project): readonly string[] {
  return typeof p.match === "string" ? [p.match] : p.match;
}

/** A stable key for the project: its first match, so single-string tables keep their keys. */
export function projectId(p: Project): string {
  return matchesOf(p)[0] ?? "";
}

/** True when `key` is a configured project's projectId. */
export const isProjectKey = (key: string): boolean => PROJECTS.some((p) => projectId(p) === key);

/** The matching project, or NO_PROJECT (a fresh copy) when none matches. */
export function projectOf(directory: string | null | undefined): Project {
  const d = String(directory ?? "").toLowerCase();
  for (const p of PROJECTS) if (matchesOf(p).some((m) => d.includes(m))) return p;
  return { ...NO_PROJECT };
}
