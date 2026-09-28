// What npm run setup, doctor and uninstall act on, all injectable: the home
// folder, the checkout, the way a command runs and the way a question is
// asked. The entry points pass the real ones; the tests pass a temp home and
// fakes, so nothing under test touches this machine's settings or cmux.

import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
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
}

/** Runs one command with an argument array, never through a shell. */
export type Runner = (cmd: string, args: readonly string[], opts?: RunOptions) => RunResult;

export interface Env {
  home: string;
  /** The checkout the script runs from. */
  repo: string;
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
    env: { ...process.env, CMUX_QUIET: "1" },
  });
  const missing = r.error !== undefined && "code" in r.error && r.error.code === "ENOENT";
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "", missing };
};

/** Every path the three scripts read or write, from one home and one checkout. */
export function pathsFor(home: string, repo: string) {
  const cmuxterm = join(home, ".cmuxterm");
  const claude = join(home, ".claude");
  const app = join(home, "Applications", "CmuxCockpit.app");
  return {
    mainCheckout: join(home, ".config", "cmux"),
    cmuxJson: join(repo, "cmux.json"),
    cmuxExample: join(repo, "cmux.example.json"),
    projects: join(repo, "config", "projects.json"),
    projectsExample: join(repo, "config", "projects.example.json"),
    urlToken: join(repo, "config", "url-token"),
    nodeModules: join(repo, "node_modules"),
    sidebars: join(repo, "sidebars"),
    src: join(repo, "src"),
    findNode: join(repo, "scripts", "find-node.sh"),
    installHelper: join(repo, "scripts", "install-helper.ts"),
    repoAutomations: join(repo, "automations.json"),
    cmuxterm,
    automationsLink: join(cmuxterm, "automations.json"),
    automationsBackup: join(cmuxterm, "automations.json.backup"),
    claudeDir: claude,
    claudeSettings: join(claude, "settings.json"),
    claudeBackup: join(claude, "settings.json.cmux-cockpit.bak"),
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
    run: realRun,
    print: (line) => console.log(line),
    ask: askTerminal,
    interactive: process.stdin.isTTY === true && process.stdout.isTTY === true,
    nodeVersion: process.versions.node,
    now: () => new Date(),
  };
}
