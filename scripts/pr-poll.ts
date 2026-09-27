// Finds each cmux workspace's pull request and saves it in config/state.json
// (the `prs` map, docs/state-loop.md), because cmux sends custom sidebars no
// PR data (issue #7).
//   node scripts/pr-poll.ts
// Run by the pr-poll rules in automations.json when an agent's turn ends or a
// workspace is selected. For every workspace in every window it reads the git
// branch of its directory and asks gh for that branch's PR, then rebuilds the
// sidebars only if a PR changed. It never fails loudly: every problem is a log
// line and exit 0. No shell: every command is spawnSync with an argument
// array, since directories and branch names come from outside.

import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { type SavedPr, type State, validateState } from "./state-config.ts";
import { writePrs } from "./state-url.ts";

const LOG_PATH = join(homedir(), "Library", "Logs", "cmux-cockpit-state.log");
const TIMEOUT_MS = 15_000;
const CMUX_FALLBACK = "/Applications/cmux.app/Contents/Resources/bin/cmux";

export interface WorkspaceDir {
  id: string;
  directory: string;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

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

/**
 * The branch's PR from `gh pr list --json number,state,url,headRefName,updatedAt`:
 * an open one first, else the most recently updated. Null when there is none;
 * undefined when the output cannot be read, so the caller keeps what it had.
 */
export function pickPr(text: string, branch: string): SavedPr | null | undefined {
  const v = parseJson(text);
  if (!Array.isArray(v)) return undefined;
  const prs = v.flatMap((p): (SavedPr & { updatedAt: string })[] => {
    if (!isRecord(p) || p.headRefName !== branch) return [];
    const status = typeof p.state === "string" ? STATUS[p.state] : undefined;
    if (!status || typeof p.number !== "number" || typeof p.url !== "string") return [];
    const updatedAt = typeof p.updatedAt === "string" ? p.updatedAt : "";
    return [{ number: p.number, url: p.url, status, branch, updatedAt }];
  });
  prs.sort(
    (a, b) => Number(b.status === "open") - Number(a.status === "open") || b.updatedAt.localeCompare(a.updatedAt),
  );
  const top = prs[0];
  return top ? { number: top.number, url: top.url, status: top.status, branch: top.branch } : null;
}

export interface Lookups {
  /** The directory's current branch, or null when it is not on one (or not a repo). */
  branchOf: (directory: string) => string | null;
  /** The branch's PR, null for none, undefined when gh failed. */
  prFor: (directory: string, branch: string) => SavedPr | null | undefined;
}

/**
 * The new `prs` map. Each directory and branch is asked once however many
 * workspaces share it. A workspace whose lookup failed keeps its previous
 * entry, so a network blip does not blank the chips; closed workspaces drop out.
 */
export function findPrs(workspaces: WorkspaceDir[], previous: State["prs"], look: Lookups): State["prs"] {
  const branches = new Map<string, string | null>();
  const found = new Map<string, SavedPr | null | undefined>();
  const out: State["prs"] = {};
  for (const w of workspaces) {
    if (!branches.has(w.directory)) branches.set(w.directory, look.branchOf(w.directory));
    const branch = branches.get(w.directory);
    if (!branch) continue;
    const key = `${w.directory}\n${branch}`;
    if (!found.has(key)) found.set(key, look.prFor(w.directory, branch));
    const pr = found.get(key);
    const kept = pr === undefined ? previous[w.id] : pr;
    if (kept && kept.branch === branch) out[w.id] = kept;
  }
  return out;
}

// ---- the real lookups -------------------------------------------------------

function log(line: string): void {
  try {
    appendFileSync(LOG_PATH, `${new Date().toISOString()} pr-poll ${line}\n`);
  } catch {
    // ignored: logging is best-effort
  }
}

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

function main(): number {
  const cmux = tool("cmux", [CMUX_FALLBACK]);
  const git = tool("git", ["/opt/homebrew/bin/git", "/usr/bin/git"]);
  const gh = tool("gh", ["/opt/homebrew/bin/gh", "/usr/local/bin/gh"]);

  const workspaces = listWorkspaces(cmux);
  if (!workspaces) {
    log("skipped: cannot list cmux workspaces");
    return 0;
  }

  const root = join(import.meta.dirname, "..");
  const stateFile = join(root, "config", "state.json");
  const previous = validateState(existsSync(stateFile) ? parseJson(readFileSync(stateFile, "utf8")) : undefined).prs;
  const prs = findPrs(workspaces, previous, {
    branchOf: (dir) => run(git, ["-C", dir, "branch", "--show-current"])?.trim() || null,
    prFor: (dir, branch) => {
      const fields = "number,state,url,headRefName,updatedAt";
      const out = run(gh, ["pr", "list", "--head", branch, "--state", "all", "--limit", "5", "--json", fields], dir);
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
  if (!applied.ok || !applied.changed) return 0;

  const build = spawnSync(process.execPath, ["scripts/build.ts"], { cwd: root, stdio: "ignore" });
  log(build.status === 0 ? `ok, ${Object.keys(prs).length} PRs` : "error: build failed");
  return 0;
}

if (import.meta.main) process.exit(main());
