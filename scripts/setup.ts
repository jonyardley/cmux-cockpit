// npm run setup: the quickstart's steps after npm ci, done for you and safe
// to run again (docs/quickstart.md). It never overwrites a file you have,
// backs up anything it replaces, asks before each optional extra, and ends
// with npm run doctor's report.
//
//   npm run setup                          # asks about each extra on a terminal
//   npm run setup -- --no-extras           # the main steps only
//   npm run setup -- --yes                 # every extra, no questions
//   npm run setup -- --helper --hooks      # just these extras, no questions

import { parseFlags } from "./setup/args.ts";
import { exitCode, report, runChecks } from "./setup/doctor-checks.ts";
import { type Env, pathsFor, realEnv } from "./setup/env.ts";
import { addExtras } from "./setup/extras.ts";
import { buildAndShow, cmuxConfig, preflight, projects } from "./setup/steps.ts";

/** Runs setup against `env`; returns the exit code. */
export async function setup(env: Env, argv: readonly string[], npmEnv: Record<string, string | undefined> = {}) {
  const flags = parseFlags(argv, npmEnv);
  if (typeof flags === "string") {
    env.print(`setup: ${flags}`);
    return 1;
  }
  const paths = pathsFor(env.home, env.repo);
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

if (import.meta.main) process.exit(await setup(realEnv(), process.argv.slice(2), process.env));
