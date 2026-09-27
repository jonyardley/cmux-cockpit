// Project identity from the workspace directory (brief: Look table).
// The table itself is not committed: scripts/build.ts injects it from
// config/projects.json (or the example table) as this define.

import type { ProjectSpec } from "../../scripts/state-config.ts";
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

// --- Projects made in the sidebar (issue #9) ---------------------------------------------
// No text input and no submenus in the renderer, so a new project takes its
// name from the folder, and colour and icon step through these sets.

/** Colours a sidebar-made project steps through. glyphColor keeps its icon readable on any of them. */
export const PROJECT_COLORS = [
  "#D97757",
  "#6A9BCC",
  "#788C5D",
  "#C2A83E",
  "#9B6FB0",
  "#CC6B8E",
  "#4F9C94",
  "#8A7F72",
] as const;

/** SF Symbols a sidebar-made project steps through; a new one starts on the first. */
export const PROJECT_ICONS = [
  "folder.fill",
  "star.fill",
  "cube.fill",
  "leaf.fill",
  "music.note",
  "hammer.fill",
  "book.fill",
  "flame.fill",
  "bolt.fill",
  "globe",
  "paintbrush.fill",
  "gearshape.fill",
] as const;

/** The item after `current`, wrapping; the first item when `current` is not in the set. */
export function nextIn(set: readonly [string, ...string[]], current: string): string {
  const i = set.findIndex((v) => v.toLowerCase() === current.toLowerCase());
  return set[(i + 1) % set.length] ?? set[0];
}

/** True when `key` is a project made in the sidebar that survived the build's merge. */
export const isInAppKey = (key: string): boolean => Object.hasOwn(SAVED_STATE.projects, key);

/** The saved spec behind a sidebar-made project, or undefined for a file project. */
export const inAppSpec = (key: string): ProjectSpec | undefined =>
  isInAppKey(key) ? SAVED_STATE.projects[key] : undefined;

/**
 * A new project for `directory`: matched and rooted there, named after its
 * last segment (capitalised, numbered if the name is taken), in the first
 * colour no project uses yet. Null for anything but an absolute path.
 */
export function newProject(
  directory: string | null | undefined,
  existing: readonly Project[],
): { key: string; spec: ProjectSpec } | null {
  const dir = String(directory ?? "").replace(/\/+$/, "");
  const last = dir.slice(dir.lastIndexOf("/") + 1);
  if (!dir.startsWith("/") || !last) return null;
  const base = last.charAt(0).toUpperCase() + last.slice(1);
  const taken = new Set(existing.map((p) => p.name));
  let name = base;
  for (let n = 2; taken.has(name); n++) name = `${base} ${n}`;
  const used = new Set(existing.map((p) => p.color.toLowerCase()));
  const color =
    PROJECT_COLORS.find((c) => !used.has(c.toLowerCase())) ??
    PROJECT_COLORS[existing.length % PROJECT_COLORS.length] ??
    PROJECT_COLORS[0];
  return { key: dir.toLowerCase(), spec: { name, color, icon: PROJECT_ICONS[0], root: dir } };
}
