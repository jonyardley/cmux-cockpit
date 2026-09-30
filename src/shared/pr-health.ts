// What a PR's chip says about it, apart from the saved state, so the
// sidebars' chips (prs.ts) and the cockpit's merged card read one rule.

import type { SavedCheck } from "../../scripts/state-config.ts";

/**
 * Only an open PR has a health, its worst state: failing checks, then merge
 * conflicts, then checks running. Ready needs GitHub's own verdict
 * (mergeable, so no conflicts or blocking review) on a PR out of draft whose
 * saved checks all passed. With no saved checks (cmux's own PR, one of Jon's
 * own PRs no workspace holds, or a repo without CI), or an entry saved
 * before the poller kept the verdict, it stays quiet rather than claim a
 * ready it cannot see.
 */
export type PrHealth = "failing" | "conflicts" | "running" | "ready" | "quiet";

export function healthOf(pr: PullRequest, checks: readonly Pick<SavedCheck, "state">[]): PrHealth {
  if (pr.status !== "open") return "quiet";
  if (checks.some((c) => c.state === "fail")) return "failing";
  if (pr.conflicts === true) return "conflicts";
  if (checks.some((c) => c.state === "pending")) return "running";
  return checks.length > 0 && !pr.draft && pr.mergeable === true ? "ready" : "quiet";
}

/** A merged PR: the card dims and offers Park and Close, and Keep in its menu (src/cockpit/merged.ts). */
export const isMergedPr = (pr: PullRequest | undefined): boolean => !!pr?.number && pr.status === "merged";
