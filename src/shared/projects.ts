// Project identity from the workspace directory (brief: Look table).
// The table itself is not committed: scripts/build.ts injects it from
// config/projects.json (or the example table) as this define.

import { P } from "./palette.ts";
import { SAVED_STATE } from "./persist.ts";

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
  /** From config/projects.json, so removing it saves a removal rather than deleting an entry. */
  seeded?: true;
}

export const PROJECTS: readonly Project[] = __PROJECTS__;

const NO_PROJECT: Project = { match: "", name: "", color: P.grey, icon: "terminal" };

/** Every path fragment the project matches, one or many. */
export function matchesOf(p: Project): readonly string[] {
  return typeof p.match === "string" ? [p.match] : p.match;
}

/** A stable key for the project: its first match, so single-string tables keep their keys. */
export function projectId(p: Project): string {
  return matchesOf(p)[0] ?? "";
}

/** The matching project, or NO_PROJECT (a fresh copy) when none matches. */
export function projectOf(directory: string | null | undefined): Project {
  // The trailing "/" lets a folder match ("/dev/app/") skip "/dev/app-old".
  const d = String(directory ?? "").toLowerCase() + "/";
  for (const p of PROJECTS) if (matchesOf(p).some((m) => d.includes(m))) return p;
  return { ...NO_PROJECT };
}

/**
 * A workspace's project: the one its Move to project choice names while that
 * is still a configured project, else its path match. The agents sidebar
 * passes the saved choice it was built with (savedProjectFor).
 */
export function projectFor(directory: string | null | undefined, choice: string | undefined): Project {
  return (choice ? PROJECTS.find((p) => projectId(p) === choice) : undefined) ?? projectOf(directory);
}

// The Move to project choice saved for workspace `id`, if any.
const savedProjectChoice = (id: string | undefined): string | undefined =>
  id && Object.hasOwn(SAVED_STATE.projectOverride, id) ? SAVED_STATE.projectOverride[id] : undefined;

/**
 * projectFor with the saved choice, for the agents sidebar: it sees a move
 * once the state write rebuilds it.
 */
export const savedProjectFor = (directory: string | null | undefined, id: string | undefined): Project =>
  projectFor(directory, savedProjectChoice(id));
