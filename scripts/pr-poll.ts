// Finds each cmux workspace's pull request and saves it in config/state.json
// (the `prs` map, docs/state-loop.md), because cmux sends custom sidebars no
// PR data (issue #7).
//   node scripts/pr-poll.ts [--delay <seconds>]
// Run by the pr-poll rules in automations.json when an agent's turn ends or a
// workspace is selected, and by the report-pr hook with a delay after an
// agent opens a PR, since gh can take a few seconds to list a new one, or
// marks one ready or merges it. For
// every workspace in every window it reads the git branch of its directory
// and asks gh for that branch's PR and its checks, then rebuilds the
// sidebars only if a PR or a check's state changed. It never fails loudly:
// every problem is a log line and exit 0. No shell: every command is
// spawnSync with an argument array, since directories and branch names come
// from outside. A lockfile stops two runs overlapping, and an overall
// deadline stops one slow run blocking every workspace behind it.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { buildNow } from "./hook-build.ts";
import { tryTakeLock } from "./lockfile.ts";
import {
  type CheckState,
  cleanLabel,
  isLineCount,
  isRecord,
  MAX_CHECKS,
  type PollError,
  type SavedCheck,
  type SavedOwnPr,
  type SavedPoll,
  type SavedPr,
  type State,
  validateState,
} from "./state-config.ts";
import { logLine } from "./state-log.ts";
import { type PollApplyResult, writePollMaps } from "./state-url.ts";
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
  if (p.mergeStateStatus === "DIRTY") pr.conflicts = true;
  if (isLineCount(p.additions)) pr.additions = p.additions;
  if (isLineCount(p.deletions)) pr.deletions = p.deletions;
  return [pr];
}

// The SavedPr a listed PR is saved as, with its title and checks.
function saved(p: Listed): SavedPr {
  const pr: SavedPr = { number: p.number, url: p.url, status: p.status, branch: p.branch };
  if (p.draft) pr.draft = true;
  if (p.mergeable) pr.mergeable = true;
  if (p.conflicts) pr.conflicts = true;
  const title = cleanTitle(p.title);
  if (title) pr.title = title;
  if (p.additions !== undefined) pr.additions = p.additions;
  if (p.deletions !== undefined) pr.deletions = p.deletions;
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

// A C1 control character (U+0080 to U+009F), which cleanLabel lets through.
const isC1 = (c: string): boolean => {
  const code = c.charCodeAt(0);
  return code >= 0x80 && code <= 0x9f;
};

/**
 * A PR title as a label: control characters, C1 ones too, become spaces,
 * then state-config's cleanLabel makes runs of space one space and cuts it
 * to MAX_LABEL UTF-16 units in whole code points (so no emoji is split),
 * the length isLabel measures, so a long title with emoji still passes
 * validation. Empty when nothing readable is left.
 */
export function cleanTitle(title: string): string {
  return cleanLabel([...title].map((c) => (isC1(c) ? " " : c)).join("")) ?? "";
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
const PR_FIELDS =
  "number,state,url,headRefName,updatedAt,isCrossRepository,isDraft,mergeStateStatus,statusCheckRollup,title,additions,deletions";
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

// The fields that differ between two saved PRs, in key order.
function fieldsChanged(was: SavedPr, now: SavedPr): string[] {
  const text = (pr: SavedPr): Map<string, string> =>
    new Map(Object.entries(pr).map(([k, v]) => [k, JSON.stringify(v)]));
  const a = text(was);
  const b = text(now);
  return [...new Set([...a.keys(), ...b.keys()])].sort().filter((k) => a.get(k) !== b.get(k));
}

// One workspace's change for prChanges, or null when its PR is the same.
function prChange(tag: string, was: SavedPr | undefined, now: SavedPr | undefined): string | null {
  if (!was || !now) return was || now ? `${tag} ${now ? "found" : "dropped"}` : null;
  const moved = fieldsChanged(was, now);
  return moved.length ? `${tag} ${moved.join(", ")}` : null;
}

/**
 * What a poll changed in the `prs` map, for its log line: each workspace
 * whose PR changed, by the first 8 characters of its id, with the fields
 * that differ ("05B6A0B0 checks, draft"), or "found" and "dropped" for a
 * PR that appeared or went. Sorted by workspace id, so the same change
 * logs the same words; empty when nothing changed.
 */
export function prChanges(before: State["prs"], after: State["prs"]): string[] {
  const ids = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  const pick = (map: State["prs"], id: string) => (Object.hasOwn(map, id) ? map[id] : undefined);
  return ids.flatMap((id) => prChange(id.slice(0, 8), pick(before, id), pick(after, id)) ?? []);
}

/** The most PR changes movedTag names before it counts the rest. */
const MAX_TAGGED = 5;

/**
 * The poll's log tag: the maps that moved, then the PR fields that did
 * (prChanges), so the log can tell a check turning green from a freshness
 * restamp, and real progress from a field going back and forth. Past
 * MAX_TAGGED changes the rest are counted ("+3 more"), so a first poll over
 * many workspaces keeps one short line.
 */
export function movedTag(maps: string[], fields: string[]): string {
  if (!maps.length) return "";
  const shown = fields.slice(0, MAX_TAGGED);
  if (fields.length > MAX_TAGGED) shown.push(`+${fields.length - MAX_TAGGED} more`);
  return ` [${maps.join(", ")}]` + (shown.length ? " " + shown.join("; ") : "");
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

// One finished (or failed to start) command, with the options every
// lookup shares.
function spawn(cmd: string, args: string[], cwd?: string) {
  return spawnSync(cmd, args, {
    cwd,
    encoding: "utf8",
    timeout: TIMEOUT_MS,
    env: { ...process.env, CMUX_QUIET: "1", GH_PROMPT_DISABLED: "1" },
  });
}

// stdout of a finished command, or null on any failure.
function run(cmd: string, args: string[], cwd?: string): string | null {
  const r = spawn(cmd, args, cwd);
  return r.status === 0 ? r.stdout : null;
}

/**
 * What one gh call says about reaching GitHub (#78): "ok" when it answered;
 * "skip" when the failure is about the directory's repo rather than gh (not
 * a repo, no GitHub remote, no default remote set, a repo the host does not
 * know), which says nothing either way; else why gh could not be reached. A
 * missing binary is "missing", a signed-out gh is "signed-out", and
 * anything else (a timeout, the network, GitHub itself) is "unavailable".
 */
export function ghOutcome(r: { status: number | null; stderr: string; missing: boolean }): "ok" | "skip" | PollError {
  if (r.missing) return "missing";
  if (r.status === 0) return "ok";
  if (/auth login|not logged in/i.test(r.stderr)) return "signed-out";
  if (/not a git repository|no git remotes|none of the git remotes|set-default|HTTP 404/i.test(r.stderr)) return "skip";
  return "unavailable";
}

/**
 * One run's lookups: how many gh calls answered, how many lookups were
 * skipped (past the deadline, or git could not say), and the worst reason a
 * gh call could not reach gh.
 */
export interface GhTally {
  answered: number;
  skipped: number;
  error?: PollError;
}

// Worst first, so a run with mixed failures always records the same one,
// whatever order the workspaces are in.
const ERROR_RANK: Record<PollError, number> = { missing: 3, "signed-out": 2, unavailable: 1 };

/** Records one gh call's outcome in the tally. */
export function tallyOutcome(tally: GhTally, outcome: "ok" | "skip" | PollError): void {
  if (outcome === "ok") tally.answered++;
  else if (outcome !== "skip" && (!tally.error || ERROR_RANK[outcome] > ERROR_RANK[tally.error])) tally.error = outcome;
}

// A saved success is refreshed only once it is this old, so a quiet run
// with gh working is not a write and a rebuild (docs/state-loop.md). Only
// the agents panel reads it (scripts/bundle.ts), so a refresh never
// reloads the cockpit.
const RESTAMP_S = 5 * 60;

/**
 * The poll status to save after a run (#78), or undefined to keep the saved
 * one. A run where gh calls failed and none answered keeps the last success
 * and records why. A run where no call answered because lookups were
 * skipped refreshed nothing, so it keeps the saved status. Any other run is
 * a success, including one that needed no gh call at all: the error clears,
 * and okEpoch is refreshed once the saved one is RESTAMP_S old.
 */
export function nextPoll(before: SavedPoll | undefined, tally: GhTally, now: number): SavedPoll | undefined {
  const kept = before?.okEpoch;
  if (tally.answered === 0 && tally.error)
    return { ...(kept === undefined ? {} : { okEpoch: kept }), error: tally.error };
  if (tally.answered === 0 && tally.skipped > 0) return undefined;
  return { okEpoch: kept !== undefined && now - kept < RESTAMP_S ? kept : now };
}

// A gh call's stdout, or null on any failure, as run gives, tallying what
// the call says about reaching gh.
function ghRun(gh: string, args: string[], cwd: string, tally: GhTally): string | null {
  const r = spawn(gh, args, cwd);
  const missing = r.error !== undefined && "code" in r.error && r.error.code === "ENOENT";
  tallyOutcome(tally, ghOutcome({ status: r.status, stderr: r.stderr ?? "", missing }));
  return r.status === 0 ? r.stdout : null;
}

// A git lookup, or undefined (counted as skipped) past the deadline or when
// git could not say.
function counted<T>(tally: GhTally, pastDeadline: () => boolean, lookup: () => T | undefined): T | undefined {
  const out = pastDeadline() ? undefined : lookup();
  if (out === undefined) tally.skipped++;
  return out;
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
const acquireLock = (lockFile: string): boolean => tryTakeLock(lockFile, LOCK_STALE_MS);

/**
 * Writes the new `prs` and `ownPrs` maps and, in the same pass, prunes the
 * `subagents` map (scripts/subagent-runs.ts): the pr-poll rules already run
 * this on every agent turn end and workspace select, so pruning here too
 * means a done row or a crashed run clears without waiting on a new subagent
 * event to trigger its own rebuild. `changed` is true when any write changed
 * the file, so the caller knows whether a rebuild is owed. `poll` is
 * writePollMaps's: saved in the same pass when given, removed when null.
 */
export function writePollState(
  stateFile: string,
  prs: State["prs"],
  ownPrs: State["ownPrs"],
  now: number,
  poll?: SavedPoll | null,
): PollApplyResult {
  return writePollMaps(stateFile, prs, ownPrs, (subagents) => prune(subagents, now), poll);
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

  const tally: GhTally = { answered: 0, skipped: 0 };
  const deadline = Date.now() + DEADLINE_MS;
  const pastDeadline = () => Date.now() > deadline;
  const prs = findPrs(workspaces, previous, {
    branchOf: (dir) => counted(tally, pastDeadline, () => gitBranch(git, dir)),
    prFor: (dir, branch) => {
      if (pastDeadline()) {
        tally.skipped++;
        return undefined;
      }
      const args = ["pr", "list", "--head", branch, "--state", "all", "--limit", "5", "--json", PR_FIELDS];
      const out = ghRun(gh, args, dir, tally);
      return out === null ? undefined : pickPr(out, branch);
    },
  });
  const ownPrs = findOwnPrs(workspaces, previousOwn, {
    repoOf: (dir) => counted(tally, pastDeadline, () => gitRepo(git, dir)),
    ownPrs: (dir, repo) => {
      if (pastDeadline()) {
        tally.skipped++;
        return undefined;
      }
      const args = ["pr", "list", "--author", "@me", "--state", "open", "--limit", OWN_LIMIT, "--json", OWN_FIELDS];
      const out = ghRun(gh, args, dir, tally);
      return out === null ? undefined : ownPrsFrom(out, repo);
    },
  });
  const now = Math.floor(Date.now() / 1000);
  const status = nextPoll(before.poll, tally, now);
  const counts = `${Object.keys(prs).length} PRs, ${Object.keys(ownPrs).length} own${status?.error ? ", gh " + status.error : ""}`;

  let applied: ReturnType<typeof writePollState>;
  try {
    applied = writePollState(stateFile, prs, ownPrs, now, status);
  } catch (err) {
    log(`error: write failed (${err instanceof Error ? err.message : String(err)})`);
    return 0;
  }
  if (!applied.ok) return 0;
  if (!applied.changed) {
    log(`ok, unchanged (${counts})`);
    return 0;
  }
  const moved = movedTag(applied.maps, prChanges(previous, prs));

  // Through hook-build.ts's lock, so this build never races a hook's and
  // lands an older bundle last. It waits briefly for a build in flight,
  // since this caller needs the result to roll back on failure; each build
  // is limited to a minute there, since this run has no outer timeout when
  // the report-pr hook starts it. Still busy after the wait, the build in
  // flight builds this write before it lets go, so nothing is rolled back.
  const built = buildNow("pr-poll");
  if (built === "built") {
    log(`ok, ${counts}${moved}`);
    return 0;
  }
  if (built === "busy") {
    log(`ok, ${counts}${moved}, built by the build in flight`);
    return 0;
  }

  // The build failed with the new maps in place: write the old ones and the
  // old poll status (none, if there was none) back so the file matches what
  // actually shows, and so the next poll sees a change again and retries
  // the build instead of staying silent. Subagent runs are left as they
  // are: a hook may have recorded one while this poll ran.
  log("error: build failed, reverted");
  try {
    writePollMaps(stateFile, previous, previousOwn, (runs) => runs, before.poll ?? null);
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
