// What npm run setup, doctor and uninstall act on, all injectable: the home
// folder, the checkout, Claude Code's config folder, the way a command runs
// and the way a question is asked. The entry points pass the real ones; the
// tests pass a temp home and fakes, so nothing under test touches this
// machine's settings or cmux.

import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { logPathFor } from "../state-log.ts";

export interface RunResult {
  /** Null when the command never ran or was killed. */
  status: number | null;
  stdout: string;
  stderr: string;
  /** Set when the command could not start at all, such as not being on PATH. */
  missing: boolean;
}

export interface RunOptions {
  cwd?: string;
  /** Show the command's own output instead of capturing it. */
  inherit?: boolean;
  /** The whole environment for the command, in place of this process's. */
  env?: Record<string, string>;
}

/** Runs one command with an argument array, never through a shell. */
export type Runner = (cmd: string, args: readonly string[], opts?: RunOptions) => RunResult;

export interface Env {
  home: string;
  /** The checkout the script runs from. */
  repo: string;
  /** CLAUDE_CONFIG_DIR as set, if at all; see claudeDirFor for when it counts. */
  claudeConfigDir: string | undefined;
  run: Runner;
  print: (line: string) => void;
  /** A yes or no question; only asked when `interactive`. */
  ask: (question: string) => Promise<boolean>;
  interactive: boolean;
  nodeVersion: string;
  now: () => Date;
}

/** The real runner: spawnSync with no shell, a two-minute cap, and cmux's alias notices silenced. */
export const realRun: Runner = (cmd, args, opts = {}) => {
  const r = spawnSync(cmd, args, {
    cwd: opts.cwd,
    encoding: "utf8",
    stdio: opts.inherit ? "inherit" : "pipe",
    timeout: 120_000,
    env: opts.env ?? { ...process.env, CMUX_QUIET: "1" },
  });
  const missing = r.error !== undefined && "code" in r.error && r.error.code === "ENOENT";
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "", missing };
};

/** `value` with a leading ~/ (or a bare ~) spelled as `home`, as a shell would. */
function expandHome(value: string, home: string): string {
  if (value === "~") return home;
  return value.startsWith("~/") ? join(home, value.slice(2)) : value;
}

/**
 * The folder Claude Code reads its settings.json from: CLAUDE_CONFIG_DIR when
 * it is set to a non-empty path that is absolute once a leading ~ is
 * expanded, else ~/.claude. A relative value is ignored, since it would hang
 * off whatever folder the script happened to run in, and handed back as
 * `ignored` so setup and the doctor can say so.
 */
function claudeDirFor(home: string, configured: string | undefined): { dir: string; ignored: string | undefined } {
  const fallback = join(home, ".claude");
  if (configured === undefined || configured === "") return { dir: fallback, ignored: undefined };
  const expanded = expandHome(configured, home);
  return isAbsolute(expanded) ? { dir: expanded, ignored: undefined } : { dir: fallback, ignored: configured };
}

/** A path as a person would type it: ~/... when it is under `home`, else as it is. */
function shown(path: string, home: string): string {
  const base = home.endsWith("/") ? home : `${home}/`;
  if (base === "/") return path;
  return path.startsWith(base) ? `~/${path.slice(base.length)}` : path;
}

/**
 * Every path the three scripts read or write, from one home, one checkout and
 * CLAUDE_CONFIG_DIR as set, if at all. The last is required, undefined when
 * unset, so a caller cannot forget it and quietly use ~/.claude.
 */
export function pathsFor(home: string, repo: string, claudeConfigDir: string | undefined) {
  const cmuxterm = join(home, ".cmuxterm");
  const { dir: claude, ignored } = claudeDirFor(home, claudeConfigDir);
  const defaultSettings = join(home, ".claude", "settings.json");
  const app = join(home, "Applications", "CmuxCockpit.app");
  return {
    mainCheckout: join(home, ".config", "cmux"),
    cmuxJson: join(repo, "cmux.json"),
    cmuxExample: join(repo, "cmux.example.json"),
    projects: join(repo, "config", "projects.json"),
    projectsExample: join(repo, "config", "projects.example.json"),
    state: join(repo, "config", "state.json"),
    scripts: join(repo, "scripts"),
    urlToken: join(repo, "config", "url-token"),
    nodeModules: join(repo, "node_modules"),
    sidebars: join(repo, "sidebars"),
    lastBuild: join(repo, "config", "last-build"),
    src: join(repo, "src"),
    findNode: join(repo, "scripts", "find-node.sh"),
    installHelper: join(repo, "scripts", "install-helper.ts"),
    repoAutomations: join(repo, "automations.json"),
    cmuxterm,
    automationsLink: join(cmuxterm, "automations.json"),
    automationsBackup: join(cmuxterm, "automations.json.backup"),
    claudeDir: claude,
    claudeSettings: join(claude, "settings.json"),
    /** claudeSettings for messages, such as ~/.claude/settings.json. */
    claudeSettingsShown: shown(join(claude, "settings.json"), home),
    claudeBackup: join(claude, "settings.json.cmux-cockpit.bak"),
    /** CLAUDE_CONFIG_DIR when it was set but not usable, so ~/.claude stands in. */
    claudeConfigIgnored: ignored,
    /**
     * ~/.claude/settings.json when CLAUDE_CONFIG_DIR moves Claude Code
     * elsewhere, so setup and the doctor can spot cockpit hooks left there;
     * undefined when it is the file in use.
     */
    otherClaudeSettings: resolve(claude, "settings.json") === defaultSettings ? undefined : defaultSettings,
    helperApp: app,
    helperPlist: join(app, "Contents", "Info.plist"),
    stateLog: logPathFor(home),
  };
}

export type Paths = ReturnType<typeof pathsFor>;

/** A local time stamp for a backup's name, such as 20260928-140502. */
export function stamp(d: Date): string {
  const two = (n: number): string => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}${two(d.getMonth() + 1)}${two(d.getDate())}-` +
    `${two(d.getHours())}${two(d.getMinutes())}${two(d.getSeconds())}`
  );
}

/** A yes or no on the terminal; anything but y or yes is no. */
async function askTerminal(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return /^y(es)?$/i.test((await rl.question(`${question} [y/N] `)).trim());
  } finally {
    rl.close();
  }
}

/** This machine: the real home, the checkout the script runs from, the real runner and terminal. */
export function realEnv(): Env {
  return {
    home: homedir(),
    repo: join(import.meta.dirname, "..", ".."),
    claudeConfigDir: process.env.CLAUDE_CONFIG_DIR,
    run: realRun,
    print: (line) => console.log(line),
    ask: askTerminal,
    interactive: process.stdin.isTTY === true && process.stdout.isTTY === true,
    nodeVersion: process.versions.node,
    now: () => new Date(),
  };
}
