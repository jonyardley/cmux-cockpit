// npm run doctor's checks, each read-only and each given the home, the
// checkout and a command runner, so the tests run them against a temp tree
// and fakes. A check says what it found and, when it fails, the one line
// that fixes it. Only node, cmux and the build are required: the rest are
// the optional extras and fall back to something that still works.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { validateProjects } from "../projects-config.ts";
import { linkState } from "./automations.ts";
import { claudeDirNotes, claudeFolders, hooksState, loadSettings } from "./claude-settings.ts";
import { type ClaudeFolder, type Env, type Paths, pathsFor } from "./env.ts";
import { atLeast, CMUX_DRAG, CMUX_MIN, NODE_MIN, parseVersion, show } from "./versions.ts";

export interface Check {
  label: string;
  ok: boolean;
  /** A failed required check makes doctor exit 1. */
  required: boolean;
  detail: string;
  /** One line that fixes a failure. */
  fix: string;
  /** Warnings shown under the check whether it passed or not. */
  notes?: readonly string[];
}

type Probe = (env: Env, paths: Paths) => Check;

const pass = (label: string, detail: string, required = false): Check => ({
  label,
  ok: true,
  required,
  detail,
  fix: "",
});
const fail = (label: string, detail: string, fix: string, required = false): Check => ({
  label,
  ok: false,
  required,
  detail,
  fix,
});

export const nodeCheck: Probe = (env) => {
  const v = parseVersion(env.nodeVersion);
  if (v && atLeast(v, NODE_MIN)) return pass("Node", env.nodeVersion, true);
  return fail("Node", `${env.nodeVersion} is older than ${show(NODE_MIN)}`, "install Node 24.2 or later", true);
};

export const cmuxCheck: Probe = (env) => {
  const r = env.run("cmux", ["--version"]);
  if (r.missing || r.status !== 0) {
    return fail("cmux", "not found on PATH", "install cmux and put its CLI on PATH (cmux's settings)", true);
  }
  // On PATH is what is required; an old or unreadable version is a warning.
  const v = parseVersion(r.stdout);
  if (!v) return fail("cmux", `could not read the version from ${JSON.stringify(r.stdout.trim())}`, "update cmux");
  if (!atLeast(v, CMUX_MIN))
    return fail("cmux", `${show(v)} is older than the tested ${show(CMUX_MIN)}`, "update cmux");
  const drag = atLeast(v, CMUX_DRAG) ? "" : ` (lane highlight while dragging needs ${show(CMUX_DRAG)})`;
  return pass("cmux", `${show(v)}${drag}`, true);
};

export const ghCheck: Probe = (env) => {
  const label = "GitHub CLI";
  const version = env.run("gh", ["--version"]);
  if (version.missing || version.status !== 0) {
    return fail(label, "gh not found; pull request chips stay empty", "brew install gh, then gh auth login");
  }
  const auth = env.run("gh", ["auth", "status"]);
  if (auth.status !== 0) return fail(label, "gh is not signed in", "gh auth login");
  return pass(label, "installed and signed in");
};

export const cmuxJsonCheck: Probe = (_env, paths) => {
  const label = "cmux.json";
  if (!existsSync(paths.cmuxJson)) {
    return fail(label, "missing", "cp cmux.example.json cmux.json && cmux reload-config");
  }
  try {
    const parsed: unknown = JSON.parse(readFileSync(paths.cmuxJson, "utf8"));
    if (typeof parsed === "object" && parsed !== null && "customSidebars" in parsed) {
      return pass(label, "has the customSidebars block");
    }
  } catch {
    return fail(label, "is not valid JSON", "fix it, or compare it with cmux.example.json");
  }
  return fail(label, "has no customSidebars block", "copy the customSidebars block from cmux.example.json");
};

export const projectsCheck: Probe = (_env, paths) => {
  const label = "Projects";
  if (!existsSync(paths.projects)) {
    return fail(label, "no config/projects.json; the example table is built in", "npm run setup, or copy the example");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(paths.projects, "utf8"));
  } catch {
    return fail(label, "config/projects.json is not valid JSON", "fix config/projects.json, then npm run build");
  }
  const r = validateProjects(parsed);
  return r.ok
    ? pass(label, `config/projects.json has ${r.projects.length} projects`)
    : fail(label, `config/projects.json ${r.error}`, "fix config/projects.json, then npm run build");
};

// The .ts files under `dir`, every depth when `deep`, as full paths.
function tsUnder(dir: string, deep: boolean): string[] {
  return readdirSync(dir, { recursive: deep, encoding: "utf8" })
    .filter((f) => f.endsWith(".ts"))
    .map((f) => join(dir, f));
}

/** What a build reads, as hook-build.ts's buildInputs lists it: src/, the build's scripts, the project table and saved state. */
function buildInputs(paths: Paths): string[] {
  return [
    ...tsUnder(paths.src, true),
    ...tsUnder(paths.scripts, false),
    paths.projects,
    paths.projectsExample,
    paths.state,
  ];
}

// The newest modification time among `files`; missing ones are skipped.
const newest = (files: readonly string[]): number =>
  Math.max(0, ...files.map((f) => statSync(f, { throwIfNoEntry: false })?.mtimeMs ?? 0));

export const buildCheck: Probe = (_env, paths) => {
  const label = "Build";
  const built = ["cockpit.js", "agents.js"].map((f) => join(paths.sidebars, f));
  const missing = built.filter((f) => !existsSync(f));
  if (missing.length > 0) return fail(label, "the sidebars are not built", "npm run build", true);
  // The build's own mark, since a bundle it left unchanged keeps its old time.
  const mark = statSync(paths.lastBuild, { throwIfNoEntry: false });
  if (!mark || mark.mtimeMs < newest(buildInputs(paths))) {
    return fail(label, "older than src/, the scripts or config/", "npm run build", true);
  }
  return pass(label, "the last build is newer than what it is built from", true);
};

export const helperCheck: Probe = (env, paths) => {
  const label = "Helper app";
  if (!existsSync(paths.helperApp)) {
    return fail(label, "not installed; dismissals last until the sidebar reloads", "npm run helper");
  }
  const r = env.run("/usr/bin/plutil", [
    "-extract",
    "CFBundleURLTypes.0.CFBundleURLSchemes.0",
    "raw",
    "-o",
    "-",
    paths.helperPlist,
  ]);
  if (r.status === 0 && r.stdout.trim() === "cmux-cockpit") return pass(label, "installed, claims cmux-cockpit://");
  return fail(label, "installed, but its Info.plist has no cmux-cockpit:// scheme", "npm run helper");
};

export const automationsCheck: Probe = (_env, paths) => {
  const label = "Automations";
  const state = linkState(paths);
  if (state.kind === "ours") return pass(label, "~/.cmuxterm/automations.json links to this repo");
  const found = state.kind === "missing" ? "not linked" : state.target ? "links elsewhere" : "a plain file, not a link";
  return fail(label, `${found}; pull request chips wait for a poll`, "npm run setup -- --automations");
};

// What is wrong with one folder's hooks, naming its file, and whether setup
// can fix it or the file needs a hand first; null when nothing is.
function folderProblem(env: Env, folder: ClaudeFolder): { why: string; byHand: boolean } | null {
  const loaded = loadSettings(folder);
  if (!loaded.ok) return { why: `${folder.shown} is ${loaded.error}`, byHand: true };
  if (!loaded.existed) return { why: `no ${folder.shown}`, byHand: false };
  const { missing, legacy } = hooksState(loaded.settings, env.home);
  const problems = [
    ...(missing.length > 0 ? [`is missing ${missing.length} entry points`] : []),
    ...(legacy > 0 ? [`still has ${legacy} old per-script hooks, so those scripts run twice`] : []),
  ];
  return problems.length === 0 ? null : { why: `${folder.shown} ${problems.join(" and ")}`, byHand: false };
}

// Every folder setup writes to is checked, and each one wanting a fix is named.
function hooksFound(env: Env, paths: Paths): Check {
  const label = "Claude Code hooks";
  const folders = claudeFolders(paths);
  const problems = folders.flatMap((f) => folderProblem(env, f) ?? []);
  if (problems.length === 0) return pass(label, `entry points in ${folders.map((f) => f.shown).join(" and ")}`);
  const fix = problems.some((p) => p.byHand)
    ? "fix the file by hand, then npm run setup -- --hooks"
    : "npm run setup -- --hooks";
  return fail(label, problems.map((p) => p.why).join("; "), fix);
}

export const hooksCheck: Probe = (env, paths) => {
  const check = hooksFound(env, paths);
  const notes = claudeDirNotes(paths);
  return notes.length === 0 ? check : { ...check, notes };
};

export const tokenCheck: Probe = (_env, paths) =>
  existsSync(paths.urlToken)
    ? pass("Link token", "config/url-token present")
    : fail("Link token", "config/url-token missing, so the helper refuses every tap", "npm run build");

/** The PATH AppleScript's do shell script gives the helper at tap time, whatever the shell running doctor has. */
export const HELPER_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";

// Run as the helper runs it: that PATH and home only, none of this shell's
// fnm or nvm variables, so the line names the node a tap would really use.
export const findNodeCheck: Probe = (env, paths) => {
  const label = "Node for the helper";
  const r = env.run("/bin/sh", [paths.findNode], { env: { HOME: env.home, PATH: HELPER_PATH } });
  const found = r.stdout.trim();
  if (r.status === 0 && found !== "") return pass(label, found);
  return fail(
    label,
    "find-node.sh finds no node with the helper's PATH, so taps do nothing",
    "install Node with fnm, nvm, volta, asdf, mise or Homebrew (see scripts/find-node.sh)",
  );
};

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * The last `keep` log lines from the past week whose message starts with
 * refused or error, after a tag such as "pr-poll". Older ones are left out,
 * so a problem fixed last month does not cross the check for good.
 */
export function problemLines(log: string, now: Date, keep = 5): string[] {
  return log
    .split("\n")
    .filter((l) => /^\S+ (?:[a-z-]+ )?(?:refused|error)\b/.test(l))
    .filter((l) => now.getTime() - Date.parse(l.slice(0, l.indexOf(" "))) < WEEK_MS)
    .slice(-keep);
}

export const logCheck: Probe = (env, paths) => {
  const label = "State log";
  if (!existsSync(paths.stateLog)) return pass(label, "no log yet");
  const lines = problemLines(readFileSync(paths.stateLog, "utf8"), env.now());
  if (lines.length === 0) return pass(label, "no refused or error lines this week");
  return fail(label, `recent problems:\n${lines.map((l) => `      ${l}`).join("\n")}`, `read ${paths.stateLog}`);
};

export const CHECKS: readonly Probe[] = [
  nodeCheck,
  cmuxCheck,
  ghCheck,
  cmuxJsonCheck,
  projectsCheck,
  buildCheck,
  helperCheck,
  automationsCheck,
  hooksCheck,
  tokenCheck,
  findNodeCheck,
  logCheck,
];

// A check that throws (an unreadable folder, say) reads as a failure, not a crash.
function safely(probe: Probe, env: Env, paths: Paths): Check {
  try {
    return probe(env, paths);
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    return fail("A check", `could not finish: ${why}`, "see the message; the path in it is usually the cause");
  }
}

/** Runs every check. */
export const runChecks = (env: Env): Check[] => {
  const paths = pathsFor(env.home, env.repo, env.claudeConfigDir);
  return CHECKS.map((c) => safely(c, env, paths));
};

/** One line per check, a tick or a cross, with the fix under each cross. */
export function report(checks: readonly Check[]): string[] {
  return checks.flatMap((c) => [
    ...(c.ok ? [`✓ ${c.label}: ${c.detail}`] : [`✗ ${c.label}: ${c.detail}`, `    fix: ${c.fix}`]),
    ...(c.notes ?? []).map((n) => `    ! ${n}`),
  ]);
}

/** 1 when a required check failed, else 0. */
export const exitCode = (checks: readonly Check[]): number => (checks.some((c) => c.required && !c.ok) ? 1 : 0);
