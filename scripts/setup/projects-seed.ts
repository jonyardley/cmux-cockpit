// A first config/projects.json from the workspaces open in cmux: one project
// per git repo, matched on its path under home, named after its folder, with
// the colours and icons the sidebar's own "New project from this folder"
// steps through. Pure, so it is tested without cmux or git.

import { PROJECT_COLORS, PROJECT_ICONS } from "../../src/shared/project-sets.ts";
import type { Project } from "../projects-config.ts";

/** Every workspace's current_directory in `cmux --json list-workspaces` output, or [] for anything else. */
export function workspaceDirs(parsed: unknown): string[] {
  if (typeof parsed !== "object" || parsed === null || !("workspaces" in parsed)) return [];
  const list = parsed.workspaces;
  if (!Array.isArray(list)) return [];
  const dirs: string[] = [];
  for (const w of list) {
    if (typeof w !== "object" || w === null || !("current_directory" in w)) continue;
    const d = w.current_directory;
    if (typeof d === "string" && d.startsWith("/")) dirs.push(d);
  }
  return dirs;
}

/** "my-app" or "my_app" as "My App". */
export function titleFrom(folder: string): string {
  return folder
    .split(/[-_\s]+/)
    .filter((w) => w !== "")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

const trimSlash = (p: string): string => p.replace(/(.)\/+$/, "$1");

// The folder under home ("/dev/my-app"), or the full path for one outside it.
function underHome(path: string, home: string): string {
  return path.startsWith(`${home}/`) ? path.slice(home.length) : path;
}

// The name, made unique with the parent folder, then a number.
function uniqueName(path: string, taken: Set<string>): string {
  const parts = path.split("/").filter((p) => p !== "");
  const base = titleFrom(parts.at(-1) ?? "") || "Project";
  const parent = parts.at(-2);
  const tries = [base, ...(parent ? [`${base} (${parent})`] : [])];
  for (let n = 2; ; n++) {
    const name = tries.find((t) => !taken.has(t));
    if (name) return name;
    tries.push(`${base} ${n}`);
  }
}

/**
 * One project per distinct repo in `tops` (git top levels), in the order
 * first seen, skipping home itself and the cockpit's own checkout (`skip`
 * and anything inside it). The match ends in "/" so "/dev/app/" does not
 * also claim "/dev/app-old", as the sidebar's own new projects do.
 */
export function seedProjects(tops: readonly string[], home: string, skip: readonly string[]): Project[] {
  const skipped = [home, ...skip].map(trimSlash);
  const seen = new Set<string>();
  const names = new Set<string>();
  const projects: Project[] = [];
  for (const raw of tops) {
    const path = trimSlash(raw);
    if (skipped.some((s) => path === s || (s !== home && path.startsWith(`${s}/`)))) continue;
    const match = `${underHome(path, home).toLowerCase()}/`;
    if (seen.has(match)) continue;
    seen.add(match);
    const name = uniqueName(path, names);
    names.add(name);
    const i = projects.length;
    projects.push({
      match,
      name,
      color: PROJECT_COLORS[i % PROJECT_COLORS.length] ?? PROJECT_COLORS[0],
      icon: PROJECT_ICONS[i % PROJECT_ICONS.length] ?? PROJECT_ICONS[0],
      root: path.startsWith(`${home}/`) ? `~${underHome(path, home)}` : path,
    });
  }
  return projects;
}

/** The table as projects.json holds it: one project per line, like the example. */
export function projectsJson(projects: readonly Project[]): string {
  return `[\n${projects.map((p) => `  ${JSON.stringify(p)}`).join(",\n")}\n]\n`;
}
