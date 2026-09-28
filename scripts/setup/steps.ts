// npm run setup's main steps, the quickstart's by-hand steps in order. Each
// is safe to run again: it copies a file only when it is missing, never
// overwrites one, and says what it found. Every command goes through
// env.run, so the tests run the lot against a temp home with fakes.

import { copyFileSync, existsSync, realpathSync, writeFileSync } from "node:fs";
import { validateProjects } from "../projects-config.ts";
import { cmuxCheck, cmuxJsonCheck, nodeCheck } from "./doctor-checks.ts";
import type { Env, Paths } from "./env.ts";
import { projectsJson, seedProjects, workspaceDirs } from "./projects-seed.ts";

// The same file, symbolic links resolved, so a ~/.config that is itself a link still counts.
function samePlace(a: string, b: string): boolean {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return a === b;
  }
}

/** Null when setup can go on, else why it stopped. The Node and cmux checks are the doctor's own. */
export function preflight(env: Env, paths: Paths): string | null {
  for (const check of [nodeCheck(env, paths), cmuxCheck(env, paths)]) {
    if (check.ok) env.print(`✓ ${check.label} ${check.detail}`);
    else if (check.required) return `${check.label}: ${check.detail}. Fix: ${check.fix}.`;
    else env.print(`! ${check.label}: ${check.detail}`);
  }
  if (!samePlace(env.repo, paths.mainCheckout)) {
    return `This checkout is at ${env.repo}, but cmux reads sidebars only from ${paths.mainCheckout}. Clone it there.`;
  }
  if (!existsSync(paths.nodeModules)) return "node_modules is missing: run npm ci first.";
  return null;
}

/** Copies cmux.example.json into place if there is no cmux.json, checks one that exists, then reloads the config. */
export function cmuxConfig(env: Env, paths: Paths): void {
  if (!existsSync(paths.cmuxJson)) {
    copyFileSync(paths.cmuxExample, paths.cmuxJson);
    env.print("✓ cmux.json: copied from cmux.example.json");
  } else {
    const check = cmuxJsonCheck(env, paths);
    if (check.ok) env.print(`✓ cmux.json: already there, ${check.detail}`);
    else env.print(`! cmux.json ${check.detail}; setup leaves your file alone. Fix: ${check.fix}.`);
  }
  env.run("cmux", ["reload-config"]);
}

// Each open workspace's repo, as git's top level, in the order cmux lists them.
function openRepos(env: Env): string[] {
  const list = env.run("cmux", ["--json", "list-workspaces"]);
  if (list.status !== 0) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(list.stdout);
  } catch {
    return [];
  }
  const tops: string[] = [];
  for (const dir of workspaceDirs(parsed)) {
    const top = env.run("git", ["-C", dir, "rev-parse", "--show-toplevel"]);
    if (top.status === 0 && top.stdout.trim() !== "") tops.push(top.stdout.trim());
  }
  return tops;
}

/** Writes config/projects.json from the open workspaces, or the example table, only when there is none. */
export function projects(env: Env, paths: Paths): void {
  if (existsSync(paths.projects)) {
    env.print("✓ config/projects.json: already there, left as it is");
    return;
  }
  const seeded = seedProjects(openRepos(env), env.home, [paths.mainCheckout]);
  if (seeded.length > 0 && validateProjects(seeded).ok) {
    writeFileSync(paths.projects, projectsJson(seeded));
    env.print(`✓ config/projects.json: one project for each of ${seeded.length} repos open in cmux:`);
    for (const p of seeded) env.print(`    ${p.name} (${p.root})`);
    env.print("  Edit names, colours and icons there, then npm run build.");
    return;
  }
  copyFileSync(paths.projectsExample, paths.projects);
  env.print("✓ config/projects.json: copied the example (no repos open in cmux). Edit it, then npm run build.");
}

/** Builds the sidebars and shows them; false when the build failed. */
export function buildAndShow(env: Env): boolean {
  const build = env.run("npm", ["run", "build"], { cwd: env.repo, inherit: true });
  if (build.status !== 0) {
    env.print("✗ npm run build failed; the output above says why.");
    return false;
  }
  env.print("✓ built sidebars/cockpit.js and sidebars/agents.js");
  env.run("cmux", ["sidebar", "select", "cockpit"]);
  env.run("cmux", ["right-sidebar", "set", "custom", "agents"]);
  env.print("✓ cockpit in the left sidebar, agents panel in the right");
  return true;
}
