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
