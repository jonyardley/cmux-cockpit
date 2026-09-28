// npm run setup's main steps, the quickstart's by-hand steps in order. Each
// is safe to run again: it copies a file only when it is missing, never
// overwrites one, and says what it found. Every command goes through
// env.run, so the tests run the lot against a temp home with fakes.

import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { validateProjects } from "../projects-config.ts";
import type { Env, Paths } from "./env.ts";
import { projectsJson, seedProjects, workspaceDirs } from "./projects-seed.ts";
import { atLeast, CMUX_DRAG, CMUX_MIN, NODE_MIN, parseVersion, show } from "./versions.ts";

/** Null when setup can go on, else why it stopped. */
export function preflight(env: Env, paths: Paths): string | null {
  const node = parseVersion(env.nodeVersion);
  if (!node || !atLeast(node, NODE_MIN))
    return `Node ${env.nodeVersion} is too old: install ${show(NODE_MIN)} or later.`;
  env.print(`✓ Node ${env.nodeVersion}`);

  const cmux = env.run("cmux", ["--version"]);
  if (cmux.missing || cmux.status !== 0) {
    return "cmux is not on PATH. Install cmux, then turn on its command line tool in cmux's settings.";
  }
  const v = parseVersion(cmux.stdout);
  if (!v || !atLeast(v, CMUX_MIN)) {
    env.print(`! cmux ${v ? show(v) : "(version unknown)"} is older than ${show(CMUX_MIN)}, the tested version.`);
  } else {
    env.print(
      `✓ cmux ${show(v)}${atLeast(v, CMUX_DRAG) ? "" : ` (lane highlight while dragging needs ${show(CMUX_DRAG)})`}`,
    );
  }

  if (env.repo !== paths.mainCheckout) {
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
  } else if (hasCustomSidebars(readFileSync(paths.cmuxJson, "utf8"))) {
    env.print("✓ cmux.json: already there, with custom sidebars on");
  } else {
    env.print("! cmux.json has no customSidebars block. Copy it from cmux.example.json; setup leaves your file alone.");
  }
  env.run("cmux", ["reload-config"]);
}

function hasCustomSidebars(text: string): boolean {
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null && "customSidebars" in parsed;
  } catch {
    return false;
  }
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
