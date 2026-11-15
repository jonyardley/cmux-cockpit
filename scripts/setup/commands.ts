// setup and uninstall as functions of an Env, so the tests run them against
// a temp home with fakes; scripts/setup.ts and scripts/uninstall.ts only
// hand them the real one.

import { parseFlags } from "./args.ts";
import { exitCode, report, runChecks } from "./doctor-checks.ts";
import { type Env, pathsFor } from "./env.ts";
import { addExtras, removeExtras } from "./extras.ts";
import { buildAndShow, cmuxConfig, preflight, projects } from "./steps.ts";

/** Runs setup against `env`; returns the exit code. */
export async function setup(env: Env, argv: readonly string[]) {
  const flags = parseFlags(argv);
  if (typeof flags === "string") {
    env.print(`setup: ${flags}`);
    return 1;
  }
  const paths = pathsFor(env.home, env.repo, env.claudeConfigDir);
  const stop = preflight(env, paths);
  if (stop) {
    env.print(`✗ ${stop}`);
    return 1;
  }
  cmuxConfig(env, paths);
  projects(env, paths);
  if (!buildAndShow(env)) return 1;
  await addExtras(env, paths, flags);
  env.print("");
  env.print("npm run doctor:");
  const checks = runChecks(env);
  for (const line of report(checks)) env.print(line);
  return exitCode(checks);
}

/** What to paste to delete the clone, from the quickstart's "Removing it". */
export const REMOVE_CLONE = [
  "mkdir -p ~/cmux-cockpit-keep",
  "cp ~/.config/cmux/cmux.json ~/.config/cmux/config/projects.json ~/.config/cmux/config/state.json ~/cmux-cockpit-keep/ 2>/dev/null",
  "rm -rf ~/.config/cmux",
  "[ -e ~/.config/cmux.backup ] && mv ~/.config/cmux.backup ~/.config/cmux",
] as const;

/** Runs uninstall against `env`; returns the exit code. */
export async function uninstall(env: Env, argv: readonly string[]) {
  const flags = parseFlags(argv);
  if (typeof flags === "string") {
    env.print(`uninstall: ${flags}`);
    return 1;
  }
  if (!flags.yes && !env.interactive) {
    env.print("uninstall: not on a terminal, so nothing was removed. Pass --yes to remove without asking.");
    return 1;
  }
  await removeExtras(env, pathsFor(env.home, env.repo, env.claudeConfigDir), flags);
  env.print("");
  env.print("The clone is still there. To remove it, keeping your own files in ~/cmux-cockpit-keep:");
  for (const line of REMOVE_CLONE) env.print(`  ${line}`);
  return 0;
}
