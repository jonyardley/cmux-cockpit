// Whether a workspace's branch is its repo's default branch, where no PR
// is looked up for it: a PR whose head is the default branch (one merged
// backwards into a spike, say) is never that workspace's work. The native
// poll asks this before it asks gh (native/core/src/pr_poll/gh.rs mirrors
// it, and its tests and these hold the two to the same answers).
//
// The default branch comes from `git symbolic-ref refs/remotes/origin/HEAD`:
// local and quick, recorded by `git clone` and shared by every worktree of
// the repo, so no network call is spent per poll as `gh repo view` would.
// A repo made with `git init` and `remote add`, or with no remote called
// origin, has no such ref; then `main` and `master` count as the default.

/** The names taken as the default branch when git cannot say which it is. */
export const USUAL_DEFAULTS: readonly string[] = ["main", "master"];

/** The arguments for `git` that print the remote's default branch as `origin/main`. */
export function defaultBranchArgs(directory: string): string[] {
  return ["-C", directory, "symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"];
}

/**
 * The default branch from defaultBranchArgs' run: the name after `origin/`,
 * which may itself hold a slash. Null when git could not say.
 */
export function defaultFromGit(r: { status: number | null; stdout: string }): string | null {
  if (r.status !== 0) return null;
  const out = r.stdout.trim();
  return out.startsWith("origin/") && out.length > "origin/".length ? out.slice("origin/".length) : null;
}

/** Whether `branch` is the default branch: the one git named, else `main` or `master`. */
export function isDefaultBranch(branch: string, defaultBranch: string | null): boolean {
  return defaultBranch === null ? USUAL_DEFAULTS.includes(branch) : branch === defaultBranch;
}
