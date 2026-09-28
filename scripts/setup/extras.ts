// The optional extras, each added by setup and taken out by uninstall.
// Each says in one line what it adds, and asks first unless the flags have
// already answered (args.ts's choose).

import { existsSync, rmSync } from "node:fs";
import { type Choice, choose, type Extra, type Flags } from "./args.ts";
import { applyLink, linkState, planLink, removeLink, repoRuleIds } from "./automations.ts";
import { backupSettings, loadSettings, wanted, writeSettings } from "./claude-settings.ts";
import type { Env, Paths } from "./env.ts";
import { addEntries, describe, missingEntries, removeEntries } from "./hooks-merge.ts";

const LSREGISTER =
  "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";

/** What each extra adds, as setup asks about it. */
export const WHAT: Record<Extra, string> = {
  helper: "Helper app: keeps dismissals and project changes when cmux reloads the sidebar.",
  automations: "Automations: pull request chips for agents' PRs, and the agents panel kept in the right sidebar.",
  hooks: 'Claude Code hooks: amber "Asking", subagent rows, instant PR chips and the "Made here" list.',
};

async function decided(env: Env, choice: Choice, question: string): Promise<boolean> {
  if (choice === "ask") return env.ask(question);
  return choice === "yes";
}

/** Setup's extras, in order; each is asked about, or settled by the flags. */
export async function addExtras(env: Env, paths: Paths, flags: Flags): Promise<void> {
  const steps: Record<Extra, () => Promise<void> | void> = {
    helper: () => addHelper(env, paths),
    automations: () => addAutomations(env, paths),
    hooks: () => addHooks(env, paths, flags),
  };
  for (const extra of ["helper", "automations", "hooks"] as const) {
    env.print("");
    env.print(WHAT[extra]);
    const choice = choose(extra, flags, env.interactive);
    if (await decided(env, choice, `Add the ${extra}?`)) await steps[extra]();
    else env.print(`  skipped (npm run setup -- --${extra} adds it later)`);
  }
}

function addHelper(env: Env, paths: Paths): void {
  // install-helper.ts is the one copy of the build; setup runs it as npm run helper does.
  const r = env.run(process.execPath, [paths.installHelper], { cwd: env.repo, inherit: true });
  env.print(r.status === 0 ? "  ✓ helper installed" : "  ✗ the helper did not install; the output above says why");
}

function addAutomations(env: Env, paths: Paths): void {
  const plan = planLink(linkState(paths), repoRuleIds(paths));
  if (plan.do === "skip") {
    env.print(`  skipped: ${plan.why}.`);
    return;
  }
  if (plan.do === "nothing") env.print(`  ✓ ${plan.why}`);
  for (const line of applyLink(plan, paths, env.now())) env.print(`  ✓ ${line}`);
  env.run("cmux", ["automation", "reload"]);
}

async function addHooks(env: Env, paths: Paths, flags: Flags): Promise<void> {
  const loaded = loadSettings(paths);
  if (!loaded.ok) {
    env.print(`  ✗ ~/.claude/settings.json is ${loaded.error}. Nothing changed; fix it and run setup again.`);
    return;
  }
  const add = missingEntries(loaded.settings, wanted(), env.home);
  if (add.length === 0) {
    env.print("  ✓ all the hooks are already in ~/.claude/settings.json");
    return;
  }
  env.print(`  These go into ${paths.claudeSettings}; nothing already there is changed:`);
  for (const e of add) env.print(`    ${describe(e)}`);
  const confirmed = flags.yes || flags.picked.includes("hooks") || (await env.ask("  Write them?"));
  if (!confirmed) {
    env.print("  skipped, nothing written");
    return;
  }
  if (loaded.existed) env.print(`  ✓ backed up to ${backupSettings(paths, env.now())}`);
  writeSettings(paths, addEntries(loaded.settings, add));
  env.print(`  ✓ added ${add.length} hooks`);
}

/** Uninstall's steps, each confirmed: the helper, our automations link, and our hooks. */
export async function removeExtras(env: Env, paths: Paths, yes: boolean): Promise<void> {
  const confirm = async (q: string): Promise<boolean> => yes || (env.interactive && (await env.ask(q)));

  if (existsSync(paths.helperApp) && (await confirm(`Remove ${paths.helperApp}?`))) {
    env.run(LSREGISTER, ["-u", paths.helperApp]);
    rmSync(paths.helperApp, { recursive: true, force: true });
    env.print(`✓ removed ${paths.helperApp}`);
  }

  if (linkState(paths).kind === "ours" && (await confirm("Remove the automations link?"))) {
    for (const line of removeLink(paths)) env.print(`✓ ${line}`);
    env.run("cmux", ["automation", "reload"]);
  }

  await removeHooks(env, paths, confirm);
}

async function removeHooks(env: Env, paths: Paths, confirm: (q: string) => Promise<boolean>): Promise<void> {
  if (!existsSync(paths.claudeSettings)) return;
  const loaded = loadSettings(paths);
  if (!loaded.ok) {
    env.print(`✗ ~/.claude/settings.json is ${loaded.error}; its hooks are left alone.`);
    return;
  }
  const next = removeEntries(loaded.settings, wanted(), env.home);
  if (next.removed === 0) return;
  if (!(await confirm(`Remove the ${next.removed} cockpit hooks from ~/.claude/settings.json?`))) return;
  env.print(`✓ backed up to ${backupSettings(paths, env.now())}`);
  writeSettings(paths, next.settings);
  env.print(`✓ removed ${next.removed} hooks`);
}
