// A workspace's pull requests: cmux's own when it sends any, else the one
// scripts/pr-poll.ts saved in config/state.json (issue #7). cmux sends custom
// sidebars no PR data today, so the saved copy is what shows; both sidebars
// read PRs through here so the day cmux does send them, its data wins.

import type { SavedCheck, SavedPr } from "../../scripts/state-config.ts";
import { SAVED_STATE } from "./persist.ts";

// The saved PR, while the workspace's branch is not yet known (cmux has not
// reported it) or still matches the branch it was found for.
function savedFor(w: Workspace): SavedPr | undefined {
  const saved = Object.hasOwn(SAVED_STATE.prs, w.id) ? SAVED_STATE.prs[w.id] : undefined;
  return saved && (!w.branch || saved.branch === w.branch) ? saved : undefined;
}

/**
 * The app's list, else its single PR, else the saved one. A branch switch
 * to a different branch hides the saved one until the next poll.
 */
export function prsOf(w: Workspace): PullRequest[] {
  if (w.prs?.length) return w.prs;
  if (w.pr) return [w.pr];
  const saved = savedFor(w);
  return saved ? [saved] : [];
}

/** The workspace's first PR, if any. */
export const prOf = (w: Workspace | undefined): PullRequest | undefined => (w ? prsOf(w)[0] : undefined);

/**
 * The CI checks of the saved PR, in checksFrom's order. Only the poller
 * saves checks, so while cmux sends a PR of its own there are none.
 */
export function checksOf(w: Workspace): SavedCheck[] {
  if (w.prs?.length || w.pr) return [];
  return savedFor(w)?.checks ?? [];
}

/**
 * What a card's PR chip says about the PR, so a problem shows without
 * selecting the workspace. Only an open PR has a health: failing wins over
 * running, and ready means every saved check passed on a PR out of draft.
 * With no saved checks (cmux's own PR, or a repo without CI) it stays quiet
 * rather than claim a ready it cannot see.
 */
export type PrHealth = "failing" | "running" | "ready" | "quiet";

export function prHealth(w: Workspace | undefined): PrHealth {
  const pr = prOf(w);
  if (!w || pr?.status !== "open") return "quiet";
  const checks = checksOf(w);
  if (checks.some((c) => c.state === "fail")) return "failing";
  if (checks.some((c) => c.state === "pending")) return "running";
  return checks.length > 0 && !pr.draft ? "ready" : "quiet";
}

/** The chip's words: "#35 · 1 failing", "#35 · running", "#35 · ready", "#35 draft", "#35", "#35 merged". */
export function prChipText(w: Workspace | undefined): string {
  const pr = prOf(w);
  if (!w || !pr?.number) return "";
  const n = "#" + pr.number;
  const health = prHealth(w);
  if (health === "failing") return n + " · " + checksOf(w).filter((c) => c.state === "fail").length + " failing";
  if (health === "running") return n + " · running";
  if (health === "ready") return n + " · ready";
  if (pr.status === "open") return pr.draft ? n + " draft" : n;
  return pr.status ? n + " " + pr.status : n;
}
