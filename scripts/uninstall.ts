// npm run uninstall: takes out what setup's extras added, each confirmed,
// with backups first: the helper app, the automations link (only when it
// points here, putting the old file back) and only the cockpit's own
// Claude Code hooks. It never deletes the clone; it prints the
// quickstart's commands for that instead.
//
//   npm run uninstall              # asks before each step
//   npm run uninstall -- --yes     # no questions

import { parseFlags } from "./setup/args.ts";
import { type Env, pathsFor, realEnv } from "./setup/env.ts";
import { removeExtras } from "./setup/extras.ts";

/** What to paste to delete the clone, from the quickstart's "Removing it". */
export const REMOVE_CLONE = [
  "mkdir -p ~/cmux-cockpit-keep",
  "cp ~/.config/cmux/cmux.json ~/.config/cmux/config/projects.json ~/.config/cmux/config/state.json ~/cmux-cockpit-keep/ 2>/dev/null",
  "rm -rf ~/.config/cmux",
  "[ -e ~/.config/cmux.backup ] && mv ~/.config/cmux.backup ~/.config/cmux",
] as const;

/** Runs uninstall against `env`; returns the exit code. */
export async function uninstall(env: Env, argv: readonly string[], npmEnv: Record<string, string | undefined> = {}) {
  const flags = parseFlags(argv, npmEnv);
  if (typeof flags === "string") {
    env.print(`uninstall: ${flags}`);
    return 1;
  }
  if (!flags.yes && !env.interactive) {
    env.print("uninstall: not on a terminal, so nothing was removed. Pass --yes to remove without asking.");
    return 1;
  }
  await removeExtras(env, pathsFor(env.home, env.repo), flags.yes);
  env.print("");
  env.print("The clone is still there. To remove it, keeping your own files in ~/cmux-cockpit-keep:");
  for (const line of REMOVE_CLONE) env.print(`  ${line}`);
  return 0;
}

if (import.meta.main) process.exit(await uninstall(realEnv(), process.argv.slice(2), process.env));
