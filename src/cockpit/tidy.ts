// "N merged, ready to tidy" at the foot of the cockpit: the worktrees whose
// PR has merged, and one tap that opens a workspace in a main checkout with
// the close-out typed on its prompt. The cards stay in their lanes, so
// drop.ts's row counting is untouched.
//
// The command is typed, never run: workspace.create's initial_input is
// delivered as raw keystrokes and no Enter is sent, so Jon reads it and
// presses return. The cockpit's own repo gets the full close-out (pull,
// rebuild, reload, remove); any other repo only removes its worktrees, since
// its main checkout may sit on another branch and has nothing to rebuild.

import { PROJECTS, projectOf } from "../shared/projects.ts";
import { prOf } from "../shared/prs.ts";
import { cardWorkspaces } from "./model.ts";

// The cockpit's main checkout, baked in by scripts/build.ts. typeof, so a
// test that never sets it reads "" rather than throwing.
declare const __COCKPIT_ROOT__: string | undefined;
const COCKPIT_ROOT = typeof __COCKPIT_ROOT__ === "string" ? __COCKPIT_ROOT__ : "";

/** One repo's merged worktrees, by branch. */
export interface TidyRepo {
  root: string;
  branches: string[];
}

const trimSlash = (p: string): string => p.replace(/(.)\/+$/, "$1");

// A merged card's repo root and branch, or null when it has no project
// folder, no branch, or is the main checkout itself (nothing to remove).
function mergedWorktree(w: Workspace): { root: string; branch: string } | null {
  const pr = prOf(w);
  if (pr?.status !== "merged") return null;
  const root = projectOf(w.directory).root;
  const branch = w.branch ?? pr.branch;
  if (!root || !branch || !w.directory) return null;
  if (trimSlash(w.directory).toLowerCase() === trimSlash(root).toLowerCase()) return null;
  return { root, branch };
}

/** Merged worktrees grouped by repo: the cockpit's first, then PROJECTS order. */
export function tidyRepos(): TidyRepo[] {
  const byRoot = new Map<string, Set<string>>();
  for (const w of cardWorkspaces()) {
    const m = mergedWorktree(w);
    if (!m) continue;
    const set = byRoot.get(m.root) ?? new Set<string>();
    set.add(m.branch);
    byRoot.set(m.root, set);
  }
  const order = [COCKPIT_ROOT, ...PROJECTS.map((p) => p.root ?? "")];
  const rank = (root: string): number => {
    const i = order.indexOf(root);
    return i < 0 ? order.length : i;
  };
  return [...byRoot.entries()]
    .map(([root, set]) => ({ root, branches: [...set] }))
    .sort((a, b) => rank(a.root) - rank(b.root));
}

/** Every branch the strip lists, in repo order. */
export const tidyBranches = (): string[] => tidyRepos().flatMap((r) => r.branches);

// Quoted for zsh only when it has to be, so the usual path or branch reads plainly.
export function shellQuote(s: string): string {
  return /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replaceAll("'", `'\\''`)}'`;
}

function repoCommand(r: TidyRepo): string {
  const root = shellQuote(r.root);
  const remove = `wt -C ${root} remove ${r.branches.map(shellQuote).join(" ")}`;
  if (r.root !== COCKPIT_ROOT) return remove;
  return [
    `git -C ${root} pull --ff-only`,
    `npm --prefix ${root} run build`,
    "cmux automation reload",
    "cmux sidebar reload",
    remove,
  ].join(" && ");
}

/**
 * The close-out for every repo: && inside a repo, so a failed pull stops its
 * rebuild, and ; between repos, so one repo's failure leaves the rest to run.
 */
export const tidyCommand = (repos: readonly TidyRepo[]): string => repos.map(repoCommand).join(" ; ");

/** Opens a workspace in the first repo's main checkout with the close-out typed, not run. */
export function tidy(): void {
  const repos = tidyRepos();
  const first = repos[0];
  if (!first) return;
  cmux("workspace.create", { cwd: first.root, focus: true, initial_input: tidyCommand(repos) });
}
