// Finds each cmux workspace's pull request and saves it in config/state.json
// (the `prs` map, docs/state-loop.md), because cmux sends custom sidebars no
// PR data (issue #7).
//   node scripts/pr-poll.ts [--delay <seconds>]
// Run by the pr-poll rules in automations.json when an agent's turn ends or a
// workspace is selected, and by the report-pr hook with a delay after an
// agent opens a PR, since gh can take a few seconds to list a new one. For
// every workspace in every window it reads the git branch of its directory
// and asks gh for that branch's PR and its checks, then rebuilds the
// sidebars only if a PR or a check's state changed. It never fails loudly:
// every problem is a log line and exit 0. No shell: every command is
// spawnSync with an argument array, since directories and branch names come
// from outside. A lockfile stops two runs overlapping, and an overall
// deadline stops one slow run blocking every workspace behind it.

import { spawnSync } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
  type CheckState,
  isLabelChar,
  isRecord,
  MAX_CHECKS,
  MAX_LABEL,
  type SavedCheck,
  type SavedOwnPr,
  type SavedPr,
  type State,
  validateState,
} from "./state-config.ts";
import { logLine } from "./state-log.ts";
import { writePollMaps } from "./state-url.ts";
import { prune } from "./subagent-runs.ts";

const TIMEOUT_MS = 15_000;
// Once this much of a run has passed, remaining lookups are skipped rather
// than spawned, so one slow or hanging directory cannot starve the rest.
const DEADLINE_MS = 240_000;
// A lockfile older than this is a crashed run's, not a live one's.
const LOCK_STALE_MS = 5 * 60_000;
// The longest --delay honoured. A delayed run was started to catch a PR the
// run holding the lock may have missed, so it waits its turn rather than
// skip, for as long as a live run can hold the lock: past LOCK_STALE_MS the
// lock is taken as a crashed run's anyway.
const MAX_DELAY_SECONDS = 60;
const LOCK_RETRY_MS = 2_000;
const LOCK_RETRIES = LOCK_STALE_MS / LOCK_RETRY_MS;
// The rebuild after a change. Without a limit a hung build would hold the
// lock with nothing to kill it, as the hook's detached run has no outer
// timeout the way the automation runs do.
const BUILD_TIMEOUT_MS = 60_000;
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

// A PR from gh's list as the poller reads it, before it is cut down to a SavedPr.
interface Listed extends SavedPr {
  title: string;
  updatedAt: string;
  rollup: unknown;
  /** Opened from a fork (isCrossRepository). */
  fork: boolean;
}

// One entry of `gh pr list --json <PR_FIELDS>`, or nothing when it is malformed.
function listed(p: unknown): Listed[] {
  if (!isRecord(p)) return [];
  const { number, url, headRefName: branch } = p;
  const status = typeof p.state === "string" ? STATUS[p.state] : undefined;
  if (!status || typeof number !== "number" || typeof url !== "string") return [];
  if (typeof branch !== "string" || !branch) return [];
  const pr: Listed = {
    number,
    url,
    status,
    branch,
    title: typeof p.title === "string" ? p.title : "",
    updatedAt: typeof p.updatedAt === "string" ? p.updatedAt : "",
    rollup: p.statusCheckRollup,
    fork: p.isCrossRepository === true,
  };
  if (p.isDraft === true) pr.draft = true;
  if (p.mergeStateStatus === "CLEAN") pr.mergeable = true;
  return [pr];
}

// The SavedPr a listed PR is saved as, with its checks.
function saved(p: Listed): SavedPr {
  const pr: SavedPr = { number: p.number, url: p.url, status: p.status, branch: p.branch };
  if (p.draft) pr.draft = true;
  if (p.mergeable) pr.mergeable = true;
  const checks = checksFrom(p.rollup);
  return checks.length ? { ...pr, checks } : pr;
}

/**
 * The branch's PR from `gh pr list --json <PR_FIELDS>`, with its checks:
 * an open one first, else the most recently updated. A fork's PR is never
 * picked: a fork's branch of the same name is someone else's work, not
 * this workspace's. Null when there is none; undefined when the output
 * cannot be read, so the caller keeps what it had.
 */
export function pickPr(text: string, branch: string): SavedPr | null | undefined {
  const v = parseJson(text);
  if (!Array.isArray(v)) return undefined;
  const prs = v.flatMap(listed).filter((p) => p.branch === branch && !p.fork);
  prs.sort(
    (a, b) => Number(b.status === "open") - Number(a.status === "open") || b.updatedAt.localeCompare(a.updatedAt),
  );
  const top = prs[0];
  return top ? saved(top) : null;
}

// A C1 control character (U+0080 to U+009F), which isLabelChar lets through.
const isC1 = (c: string): boolean => {
  const code = c.charCodeAt(0);
  return code >= 0x80 && code <= 0x9f;
};

/**
 * A PR title as a label: control characters become spaces, runs of space
 * one space, trimmed and cut to MAX_LABEL characters (whole code points, so
 * no emoji is split), so it passes state-config's isLabel. Empty when
 * nothing readable is left.
 */
export function cleanTitle(title: string): string {
  const spaced = [...title].map((c) => (isLabelChar(c) && !isC1(c) ? c : " ")).join("");
  const words = spaced.replace(/\s+/g, " ").trim();
  return [...words].slice(0, MAX_LABEL).join("").trim();
}

/**
 * Jon's own open PRs in `repo` from `gh pr list --author @me --json
 * <OWN_FIELDS>`, keyed by url. A fork's PR counts here: it is still his.
 * A PR with no readable title is titled by its branch. Undefined when the
 * output cannot be read, so the caller keeps what it had.
 */
export function ownPrsFrom(text: string, repo: string): State["ownPrs"] | undefined {
  const v = parseJson(text);
  if (!Array.isArray(v)) return undefined;
  const out: State["ownPrs"] = {};
  for (const p of v.flatMap(listed)) {
    const title = cleanTitle(p.title) || cleanTitle(p.branch);
    if (p.status !== "open" || !title) continue;
    const pr: SavedOwnPr = { number: p.number, url: p.url, status: "open", branch: p.branch, title, repo };
    if (p.draft) pr.draft = true;
    out[p.url] = pr;
  }
  return out;
}

// The fields pickPr reads.
const PR_FIELDS = "number,state,url,headRefName,updatedAt,isCrossRepository,isDraft,mergeStateStatus,statusCheckRollup";
// The fields ownPrsFrom reads.
const OWN_FIELDS = "number,state,url,headRefName,isCrossRepository,isDraft,title";
// Jon's open PRs asked for per repo; more than this is not a sidebar list.
const OWN_LIMIT = "30";

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

export interface OwnLookups {
  /**
   * The repo a directory belongs to (git's common dir, so every worktree of
   * one repo shares it). Null when the directory is not a repo; undefined
   * when git failed or the run is past its deadline.
   */
  repoOf: (directory: string) => string | null | undefined;
  /** Jon's open PRs in the directory's repo; undefined when gh failed or was skipped. */
  ownPrs: (directory: string, repo: string) => State["ownPrs"] | undefined;
}

// Each directory's repo, asking `repoOf` at most once per directory.
function reposOf(workspaces: WorkspaceDir[], repoOf: OwnLookups["repoOf"]): Map<string, string | null | undefined> {
  const repos = new Map<string, string | null | undefined>();
  for (const { directory } of workspaces) if (!repos.has(directory)) repos.set(directory, repoOf(directory));
  return repos;
}

/**
 * The new `ownPrs` map: Jon's open PRs across every repo a workspace sits
 * in, each repo asked once however many workspaces or worktrees share it.
 * A repo whose lookup failed keeps its previous entries, and only its own,
 * so one broken repo cannot pin merged PRs from the others. When git could
 * not say which repo a directory is, every previous entry from a repo not
 * freshly asked is kept, since it may be that directory's.
 */
export function findOwnPrs(workspaces: WorkspaceDir[], previous: State["ownPrs"], look: OwnLookups): State["ownPrs"] {
  const dirs = reposOf(workspaces, look.repoOf);
  const unknown = [...dirs.values()].includes(undefined);
  const repos = new Map<string, string>();
  for (const [dir, repo] of dirs) if (repo && !repos.has(repo)) repos.set(repo, dir);
  const out: State["ownPrs"] = {};
  const asked = new Set<string>();
  for (const [repo, dir] of repos) {
    const found = look.ownPrs(dir, repo);
    if (found === undefined) continue;
    asked.add(repo);
    Object.assign(out, found);
  }
  const keep = (repo: string) => !asked.has(repo) && (unknown || repos.has(repo));
  const kept = Object.entries(previous).filter(([url, pr]) => keep(pr.repo) && !(url in out));
  return { ...Object.fromEntries(kept), ...out };
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

// git's common dir, absolute, so every worktree of a repo gives the same one.
function gitRepo(git: string, dir: string): string | null | undefined {
  const r = spawnSync(git, ["-C", dir, "rev-parse", "--path-format=absolute", "--git-common-dir"], {
    cwd: dir,
    encoding: "utf8",
    timeout: TIMEOUT_MS,
  });
  return branchFromGit({ status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" });
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

/**
 * Writes the new `prs` and `ownPrs` maps and, in the same pass, prunes the
 * `subagents` map (scripts/subagent-runs.ts): the pr-poll rules already run
 * this on every agent turn end and workspace select, so pruning here too
 * means a done row or a crashed run clears without waiting on a new subagent
 * event to trigger its own rebuild. `changed` is true when any write changed
 * the file, so the caller knows whether a rebuild is owed.
 */
export function writePollState(
  stateFile: string,
  prs: State["prs"],
  ownPrs: State["ownPrs"],
  now: number,
): { ok: true; changed: boolean } | { ok: false; error: string } {
  return writePollMaps(stateFile, prs, ownPrs, (subagents) => prune(subagents, now));
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
  const before = validateState(existsSync(stateFile) ? parseJson(readFileSync(stateFile, "utf8")) : undefined);
  const previous = before.prs;
  const previousOwn = before.ownPrs;
  const previousSubagents = before.subagents;

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
  const ownPrs = findOwnPrs(workspaces, previousOwn, {
    repoOf: (dir) => (pastDeadline() ? undefined : gitRepo(git, dir)),
    ownPrs: (dir, repo) => {
      if (pastDeadline()) return undefined;
      const args = ["pr", "list", "--author", "@me", "--state", "open", "--limit", OWN_LIMIT, "--json", OWN_FIELDS];
      const out = run(gh, args, dir);
      return out === null ? undefined : ownPrsFrom(out, repo);
    },
  });
  const counts = `${Object.keys(prs).length} PRs, ${Object.keys(ownPrs).length} own`;

  let applied: ReturnType<typeof writePollState>;
  try {
    applied = writePollState(stateFile, prs, ownPrs, Math.floor(Date.now() / 1000));
  } catch (err) {
    log(`error: write failed (${err instanceof Error ? err.message : String(err)})`);
    return 0;
  }
  if (!applied.ok) return 0;
  if (!applied.changed) {
    log(`ok, unchanged (${counts})`);
    return 0;
  }

  const build = spawnSync(process.execPath, ["scripts/build.ts"], {
    cwd: root,
    stdio: "ignore",
    timeout: BUILD_TIMEOUT_MS,
  });
  if (build.status === 0) {
    log(`ok, ${counts}`);
    return 0;
  }

  // The build failed with the new maps in place: write the old ones back so
  // the file matches what actually shows, and so the next poll sees a
  // change again and retries the build instead of staying silent.
  log("error: build failed, reverted");
  try {
    writePollMaps(stateFile, previous, previousOwn, () => previousSubagents);
  } catch (err) {
    log(`error: revert failed (${err instanceof Error ? err.message : String(err)})`);
  }
  return 0;
}

/**
 * The delay in milliseconds from `--delay <seconds>` or `--delay=<seconds>`:
 * a whole number from 1 to MAX_DELAY_SECONDS. Anything else, or no flag,
 * is no delay, so a bad argument never stops the poll.
 */
export function delayFrom(argv: string[]): number {
  const i = argv.findIndex((a) => a === "--delay" || a.startsWith("--delay="));
  if (i === -1) return 0;
  const flag = argv[i] ?? "";
  const value = flag.includes("=") ? flag.slice(flag.indexOf("=") + 1) : (argv[i + 1] ?? "");
  if (!/^\d+$/.test(value)) return 0;
  const seconds = Number(value);
  return seconds >= 1 && seconds <= MAX_DELAY_SECONDS ? seconds * 1000 : 0;
}

/**
 * Takes the lock with `acquire`, trying again up to `retries` times with a
 * `wait` between tries while another run holds it. Zero retries is one try.
 */
export async function lockWithin(
  acquire: () => boolean,
  retries: number,
  wait: () => Promise<unknown>,
): Promise<boolean> {
  for (let tries = 0; !acquire(); tries++) {
    if (tries >= retries) return false;
    await wait();
  }
  return true;
}

async function main(): Promise<number> {
  const root = join(import.meta.dirname, "..");
  const lockFile = join(root, "config", "pr-poll.lock");
  const delay = delayFrom(process.argv.slice(2));
  if (delay) await sleep(delay);
  const locked = await lockWithin(
    () => acquireLock(lockFile),
    delay ? LOCK_RETRIES : 0,
    () => sleep(LOCK_RETRY_MS),
  );
  if (!locked) {
    log("skipped: another poll is running");
    return 0;
  }
  try {
    return poll(root);
  } finally {
    rmSync(lockFile, { force: true });
  }
}

if (import.meta.main) process.exit(await main());
