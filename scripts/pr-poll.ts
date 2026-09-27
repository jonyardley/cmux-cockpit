// Finds each cmux workspace's pull request and saves it in config/state.json
// (the `prs` map, docs/state-loop.md), because cmux sends custom sidebars no
// PR data (issue #7).
//   node scripts/pr-poll.ts
// Run by the pr-poll rules in automations.json when an agent's turn ends or a
// workspace is selected. For every workspace in every window it reads the git
// branch of its directory and asks gh for that branch's PR and its checks,
// then rebuilds the sidebars only if a PR or a check's state changed. It never fails loudly: every problem is a log
// line and exit 0. No shell: every command is spawnSync with an argument
// array, since directories and branch names come from outside. A lockfile
// stops two runs overlapping, and an overall deadline stops one slow run
// blocking every workspace behind it.

import { spawnSync } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  type CheckState,
  isRecord,
  MAX_CHECKS,
  type SavedCheck,
  type SavedPr,
  type State,
  validateState,
} from "./state-config.ts";
import { logLine } from "./state-log.ts";
import { writePrs } from "./state-url.ts";

const TIMEOUT_MS = 15_000;
// Once this much of a run has passed, remaining lookups are skipped rather
// than spawned, so one slow or hanging directory cannot starve the rest.
const DEADLINE_MS = 240_000;
// A lockfile older than this is a crashed run's, not a live one's.
const LOCK_STALE_MS = 5 * 60_000;
const CMUX_FALLBACK = "/Applications/cmux.app/Contents/Resources/bin/cmux";

function log(line: string): void {
  logLine(`pr-poll ${line}`);
}

export interface WorkspaceDir {
  id: string;
  directory: string;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Window ids from `cmux rpc window.list`, or null when it cannot be read. */
export function parseWindowIds(text: string): string[] | null {
  const v = parseJson(text);
  if (!isRecord(v) || !Array.isArray(v.windows)) return null;
  return v.windows.flatMap((w) => (isRecord(w) && typeof w.id === "string" ? [w.id] : []));
}

/** Workspaces with a directory from `cmux workspace list --json`, or null when it cannot be read. */
export function parseWorkspaces(text: string): WorkspaceDir[] | null {
  const v = parseJson(text);
  if (!isRecord(v) || !Array.isArray(v.workspaces)) return null;
  return v.workspaces.flatMap((w) =>
    isRecord(w) && typeof w.id === "string" && typeof w.current_directory === "string" && w.current_directory
      ? [{ id: w.id, directory: w.current_directory }]
      : [],
  );
}

const STATUS: Record<string, SavedPr["status"]> = { OPEN: "open", MERGED: "merged", CLOSED: "closed" };

// A finished check run's conclusion: success and the ones GitHub lets
// through a required check (neutral, skipped) pass; the rest fail.
const PASSING = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);

// A CheckRun (Actions and apps) or a StatusContext (the older commit
// status API) from statusCheckRollup, in three states.
function checkState(c: Record<string, unknown>): CheckState {
  if (c.__typename === "StatusContext") {
    if (c.state === "SUCCESS") return "pass";
    return c.state === "PENDING" || c.state === "EXPECTED" ? "pending" : "fail";
  }
  if (c.status !== "COMPLETED") return "pending";
  return typeof c.conclusion === "string" && PASSING.has(c.conclusion) ? "pass" : "fail";
}

interface RolledCheck extends SavedCheck {
  id: string;
  startedAt: string;
}

function rolledCheck(c: unknown): RolledCheck[] {
  if (!isRecord(c)) return [];
  const name = typeof c.name === "string" ? c.name : c.context;
  if (typeof name !== "string" || !name.trim()) return [];
  const workflow = typeof c.workflowName === "string" ? c.workflowName : "";
  const startedAt = typeof c.startedAt === "string" ? c.startedAt : "";
  return [{ id: `${workflow}\n${name}`, name: name.trim().slice(0, 64).trim(), state: checkState(c), startedAt }];
}

// A queued run has no start yet (gh sends "" or its zero time), and is
// the newest run of its check, so it sorts after any real start.
const startKey = (at: string): string => (!at || at.startsWith("0001-") ? "\uffff" : at);

// Failing first, then running, so the cap never drops a red check.
const STATE_RANK: Record<CheckState, number> = { fail: 0, pending: 1, pass: 2 };

/**
 * The checks from gh's statusCheckRollup, failing first, then running,
 * then passed, by name within each. A workflow run again (an edited PR
 * body reruns its check) appears once per run, so only the latest started
 * run of each workflow and name is kept.
 */
export function checksFrom(rollup: unknown): SavedCheck[] {
  if (!Array.isArray(rollup)) return [];
  const latest = new Map<string, RolledCheck>();
  for (const c of rollup.flatMap(rolledCheck)) {
    const seen = latest.get(c.id);
    if (!seen || startKey(c.startedAt) >= startKey(seen.startedAt)) latest.set(c.id, c);
  }
  return [...latest.values()]
    .map(({ name, state }) => ({ name, state }))
    .sort((a, b) => STATE_RANK[a.state] - STATE_RANK[b.state] || a.name.localeCompare(b.name))
    .slice(0, MAX_CHECKS);
}

/**
 * The branch's PR from `gh pr list --json <PR_FIELDS>`, with its checks:
 * an open one first, else the most recently updated. A fork's PR
 * (isCrossRepository) is never picked, since the sidebar cannot open it the
 * way it opens one of ours. Null when there is none; undefined when the
 * output cannot be read, so the caller keeps what it had.
 */
export function pickPr(text: string, branch: string): SavedPr | null | undefined {
  const v = parseJson(text);
  if (!Array.isArray(v)) return undefined;
  const prs = v.flatMap((p): (SavedPr & { updatedAt: string; rollup: unknown })[] => {
    if (!isRecord(p) || p.headRefName !== branch || p.isCrossRepository === true) return [];
    const status = typeof p.state === "string" ? STATUS[p.state] : undefined;
    if (!status || typeof p.number !== "number" || typeof p.url !== "string") return [];
    const updatedAt = typeof p.updatedAt === "string" ? p.updatedAt : "";
    return [{ number: p.number, url: p.url, status, branch, updatedAt, rollup: p.statusCheckRollup }];
  });
  prs.sort(
    (a, b) => Number(b.status === "open") - Number(a.status === "open") || b.updatedAt.localeCompare(a.updatedAt),
  );
  const top = prs[0];
  if (!top) return null;
  const pr: SavedPr = { number: top.number, url: top.url, status: top.status, branch: top.branch };
  const checks = checksFrom(top.rollup);
  return checks.length ? { ...pr, checks } : pr;
}

// The fields pickPr reads.
const PR_FIELDS = "number,state,url,headRefName,updatedAt,isCrossRepository,statusCheckRollup";

export interface Lookups {
  /**
   * The directory's current branch. Null when it is not on one (a detached
   * HEAD) or the directory is not a repo, so its entry is dropped; undefined
   * when git itself failed, timed out, or the run is past its deadline, so
   * the caller keeps whatever it had rather than guess.
   */
  branchOf: (directory: string) => string | null | undefined;
  /** The branch's PR, null for none, undefined when gh failed or was skipped. */
  prFor: (directory: string, branch: string) => SavedPr | null | undefined;
}

// The directory's branch, asking `branchOf` at most once per directory.
function branchFor(
  dir: string,
  branches: Map<string, string | null | undefined>,
  branchOf: Lookups["branchOf"],
): string | null | undefined {
  if (!branches.has(dir)) branches.set(dir, branchOf(dir));
  return branches.get(dir);
}

// The directory and branch's PR, asking `prFor` at most once per pair.
function prForBranch(
  dir: string,
  branch: string,
  found: Map<string, SavedPr | null | undefined>,
  prFor: Lookups["prFor"],
): SavedPr | null | undefined {
  const key = `${dir}\n${branch}`;
  if (!found.has(key)) found.set(key, prFor(dir, branch));
  return found.get(key);
}

/**
 * The new `prs` map. Each directory and branch is asked once however many
 * workspaces share it. A workspace whose branch could not be read keeps its
 * previous entry as-is; one whose branch was read but has no PR, or whose
 * gh lookup failed, keeps its previous entry only while still on that same
 * branch; closed workspaces drop out.
 */
export function findPrs(workspaces: WorkspaceDir[], previous: State["prs"], look: Lookups): State["prs"] {
  const branches = new Map<string, string | null | undefined>();
  const found = new Map<string, SavedPr | null | undefined>();
  const out: State["prs"] = {};
  for (const w of workspaces) {
    const branch = branchFor(w.directory, branches, look.branchOf);
    if (branch === undefined) {
      const kept = previous[w.id];
      if (kept) out[w.id] = kept;
      continue;
    }
    if (branch === null) continue;
    const pr = prForBranch(w.directory, branch, found, look.prFor);
    const kept = pr === undefined ? previous[w.id] : pr;
    if (kept && kept.branch === branch) out[w.id] = kept;
  }
  return out;
}

// The real lookups, run as subprocesses.

// stdout of a finished command, or null on any failure.
function run(cmd: string, args: string[], cwd?: string): string | null {
  const r = spawnSync(cmd, args, {
    cwd,
    encoding: "utf8",
    timeout: TIMEOUT_MS,
    env: { ...process.env, CMUX_QUIET: "1", GH_PROMPT_DISABLED: "1" },
  });
  return r.status === 0 ? r.stdout : null;
}

/**
 * Classifies `git branch --show-current`'s raw result: the branch name;
 * null when there is none (a detached HEAD) or the exit says it is not a
 * repo; undefined when git itself failed or was killed (a timeout), so the
 * caller keeps whatever it had rather than guess why.
 */
export function branchFromGit(r: { status: number | null; stdout: string; stderr: string }): string | null | undefined {
  if (r.status === null) return undefined;
  if (r.status !== 0) return r.stderr.includes("not a git repository") ? null : undefined;
  return r.stdout.trim() || null;
}

function gitBranch(git: string, dir: string): string | null | undefined {
  const r = spawnSync(git, ["-C", dir, "branch", "--show-current"], {
    cwd: dir,
    encoding: "utf8",
    timeout: TIMEOUT_MS,
  });
  return branchFromGit({ status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" });
}

// The automation runner has the app's PATH, so each tool falls back to its
// usual install path, as restore-agents.sh does for cmux.
function tool(name: string, fallbacks: string[]): string {
  return fallbacks.find((p) => existsSync(p)) ?? name;
}

function listWorkspaces(cmux: string): WorkspaceDir[] | null {
  const windows = parseWindowIds(run(cmux, ["rpc", "window.list"]) ?? "");
  if (!windows) return null;
  const all: WorkspaceDir[] = [];
  for (const id of windows) {
    const ws = parseWorkspaces(run(cmux, ["workspace", "list", "--json", "--window", id]) ?? "");
    if (!ws) return null;
    all.push(...ws);
  }
  return all;
}

// An exclusive lockfile, so two polls can never overlap and race to write
// config/state.json. A lock older than LOCK_STALE_MS is a crashed run's, so
// it is cleared and retaken rather than honoured forever.
function acquireLock(lockFile: string): boolean {
  try {
    closeSync(openSync(lockFile, "wx"));
    return true;
  } catch {
    const age = Date.now() - (statSync(lockFile, { throwIfNoEntry: false })?.mtimeMs ?? Date.now());
    if (age <= LOCK_STALE_MS) return false;
    rmSync(lockFile, { force: true });
    try {
      closeSync(openSync(lockFile, "wx"));
      return true;
    } catch {
      return false;
    }
  }
}

function poll(root: string): number {
  const cmux = tool("cmux", [CMUX_FALLBACK]);
  const git = tool("git", ["/opt/homebrew/bin/git", "/usr/bin/git"]);
  const gh = tool("gh", ["/opt/homebrew/bin/gh", "/usr/local/bin/gh"]);

  const workspaces = listWorkspaces(cmux);
  if (!workspaces) {
    log("skipped: cannot list cmux workspaces");
    return 0;
  }

  const stateFile = join(root, "config", "state.json");
  const previous = validateState(existsSync(stateFile) ? parseJson(readFileSync(stateFile, "utf8")) : undefined).prs;

  const deadline = Date.now() + DEADLINE_MS;
  const pastDeadline = () => Date.now() > deadline;
  const prs = findPrs(workspaces, previous, {
    branchOf: (dir) => (pastDeadline() ? undefined : gitBranch(git, dir)),
    prFor: (dir, branch) => {
      if (pastDeadline()) return undefined;
      const out = run(gh, ["pr", "list", "--head", branch, "--state", "all", "--limit", "5", "--json", PR_FIELDS], dir);
      return out === null ? undefined : pickPr(out, branch);
    },
  });

  let applied: ReturnType<typeof writePrs>;
  try {
    applied = writePrs(stateFile, prs);
  } catch (err) {
    log(`error: write failed (${err instanceof Error ? err.message : String(err)})`);
    return 0;
  }
  if (!applied.ok) return 0;
  if (!applied.changed) {
    log(`ok, unchanged (${Object.keys(prs).length} PRs)`);
    return 0;
  }

  const build = spawnSync(process.execPath, ["scripts/build.ts"], { cwd: root, stdio: "ignore" });
  if (build.status === 0) {
    log(`ok, ${Object.keys(prs).length} PRs`);
    return 0;
  }

  // The build failed with the new map in place: write the old one back so
  // the file matches what actually shows, and so the next poll sees a
  // change again and retries the build instead of staying silent.
  log("error: build failed, reverted");
  try {
    writePrs(stateFile, previous);
  } catch (err) {
    log(`error: revert failed (${err instanceof Error ? err.message : String(err)})`);
  }
  return 0;
}

function main(): number {
  const root = join(import.meta.dirname, "..");
  const lockFile = join(root, "config", "pr-poll.lock");
  if (!acquireLock(lockFile)) {
    log("skipped: another poll is running");
    return 0;
  }
  try {
    return poll(root);
  } finally {
    rmSync(lockFile, { force: true });
  }
}

if (import.meta.main) process.exit(main());
