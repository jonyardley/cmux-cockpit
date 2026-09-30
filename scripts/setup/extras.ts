// The optional extras, each added by setup and taken out by uninstall.
// Each says in one line what it adds, and asks first unless the flags have
// already answered (args.ts's choose).

import { existsSync, rmSync } from "node:fs";
import { type Choice, choose, type Extra, type Flags, offered } from "./args.ts";
import { applyLink, linkState, planLink, removeLink, repoRuleIds } from "./automations.ts";
import {
  backupSettings,
  claudeDirNotes,
  claudeFolders,
  cockpit,
  loadSettings,
  stale,
  unchanged,
  wanted,
  writeSettings,
} from "./claude-settings.ts";
import type { ClaudeFolder, Env, Paths } from "./env.ts";
import { addEntries, describe, type Entry, missingEntries, removeHooks } from "./hooks-merge.ts";

const LSREGISTER =
  "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";

/** What each extra adds, as setup asks about it. */
export const WHAT: Record<Extra, string> = {
  helper: "Helper app: keeps dismissals and project changes when cmux reloads the sidebar.",
  automations: "Automations: pull request chips for agents' PRs, and the agents panel kept in the right sidebar.",
  hooks:
    'Claude Code hooks: amber "Asking", subagent rows, instant PR chips, the "Made here" list and /rename names on the workspace.',
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

// Each Claude Code folder in turn, so one that cannot be read or written never stops the others.
async function addHooks(env: Env, paths: Paths, flags: Flags): Promise<void> {
  for (const note of claudeDirNotes(paths)) env.print(`  ! ${note}`);
  for (const folder of claudeFolders(paths)) {
    await eachFolder(env, folder, "  ", () => addHooksTo(env, folder, flags));
  }
}

// Runs one folder's step, turning a thrown error (a read-only file, say) into a line.
async function eachFolder(env: Env, folder: ClaudeFolder, indent: string, step: () => Promise<void>): Promise<void> {
  try {
    await step();
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    env.print(`${indent}✗ ${folder.shown} could not be updated (${why}); the other folders carry on.`);
  }
}

async function addHooksTo(env: Env, folder: ClaudeFolder, flags: Flags): Promise<void> {
  const loaded = loadSettings(folder);
  if (!loaded.ok) {
    env.print(`  ✗ ${folder.shown} is ${loaded.error}. Nothing changed there; fix it and run setup again.`);
    return;
  }
  const cleared = removeHooks(loaded.settings, stale(env.home), env.home);
  const add = missingEntries(cleared.settings, wanted(), env.home);
  if (add.length === 0 && cleared.removed === 0) {
    env.print(`  ✓ every entry point is already in ${folder.shown}`);
    return;
  }
  listChanges(env, folder, add, cleared.removed);
  const confirmed = flags.yes || flags.picked.includes("hooks") || (await env.ask(`  Write them to ${folder.shown}?`));
  if (!confirmed) {
    env.print(`  skipped, nothing written to ${folder.shown}`);
    return;
  }
  if (!unchanged(folder, loaded)) {
    env.print(`  ✗ ${folder.shown} changed while setup waited, so nothing was written. Run setup again.`);
    return;
  }
  if (loaded.existed) env.print(`  ✓ backed up to ${backupSettings(folder, env.now())}`);
  writeSettings(folder, addEntries(cleared.settings, add));
  const swapped = cleared.removed ? `, took out ${cleared.removed} old cockpit hooks` : "";
  env.print(`  ✓ added ${add.length} entry points to ${folder.shown}${swapped}`);
}

// What addHooksTo will write: the entry points it adds, and the old per-script hooks it takes out.
function listChanges(env: Env, folder: ClaudeFolder, add: readonly Entry[], legacyCount: number): void {
  if (add.length > 0) {
    env.print(
      `  These go into ${folder.shown}, rewritten with two-space indents; nothing else there is removed or reordered:`,
    );
    for (const e of add) env.print(`    ${describe(e)}`);
  }
  if (legacyCount > 0) {
    env.print(`  ${legacyCount} old cockpit hooks come out, since the entry points run those scripts now.`);
  }
}

/** Uninstall's steps, each confirmed: the helper, our automations link, and our hooks. */
export async function removeExtras(env: Env, paths: Paths, flags: Flags): Promise<void> {
  const confirm = async (q: string): Promise<boolean> => flags.yes || (env.interactive && (await env.ask(q)));

  if (offered("helper", flags) && existsSync(paths.helperApp) && (await confirm(`Remove ${paths.helperApp}?`))) {
    env.run(LSREGISTER, ["-u", paths.helperApp]);
    rmSync(paths.helperApp, { recursive: true, force: true });
    env.print(`✓ removed ${paths.helperApp}`);
  }

  if (
    offered("automations", flags) &&
    linkState(paths).kind === "ours" &&
    (await confirm("Remove the automations link?"))
  ) {
    for (const line of removeLink(paths)) env.print(`✓ ${line}`);
    env.run("cmux", ["automation", "reload"]);
  }

  if (offered("hooks", flags)) await takeOutHooks(env, paths, confirm);
}

async function takeOutHooks(env: Env, paths: Paths, confirm: (q: string) => Promise<boolean>): Promise<void> {
  for (const folder of claudeFolders(paths)) {
    await eachFolder(env, folder, "", () => removeHooksFrom(env, folder, confirm));
  }
}

async function removeHooksFrom(
  env: Env,
  folder: ClaudeFolder,
  confirm: (q: string) => Promise<boolean>,
): Promise<void> {
  if (!existsSync(folder.settings)) return;
  const loaded = loadSettings(folder);
  if (!loaded.ok) {
    env.print(`✗ ${folder.shown} is ${loaded.error}; its hooks are left alone.`);
    return;
  }
  const next = removeHooks(loaded.settings, cockpit(env.home), env.home);
  if (next.removed === 0) return;
  if (!(await confirm(`Remove the ${next.removed} cockpit hooks from ${folder.shown}?`))) return;
  if (!unchanged(folder, loaded)) {
    env.print(`✗ ${folder.shown} changed while uninstall waited, so nothing was written. Run it again.`);
    return;
  }
  env.print(`✓ backed up to ${backupSettings(folder, env.now())}`);
  writeSettings(folder, next.settings);
  env.print(`✓ removed ${next.removed} hooks from ${folder.shown}`);
}
