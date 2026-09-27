// A workspace's pull requests: cmux's own when it sends any, else the one
// scripts/pr-poll.ts saved in config/state.json (issue #7). cmux sends custom
// sidebars no PR data today, so the saved copy is what shows; both sidebars
// read PRs through here so the day cmux does send them, its data wins.

import type { SavedCheck, SavedOwnPr, SavedPr } from "../../scripts/state-config.ts";
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

/**
 * Jon's own open PRs the poller found across the repos his workspaces sit in
 * (State.ownPrs), so a PR still shows once its workspace is closed.
 */
export function savedOwnPrs(): SavedOwnPr[] {
  return Object.values(SAVED_STATE.ownPrs);
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
 * running, and ready needs GitHub's own verdict (mergeable, so no
 * conflicts or blocking review) on a PR out of draft whose saved checks
 * all passed. With no saved checks (cmux's own PR, or a repo without CI),
 * or an entry saved before the poller kept the verdict, it stays quiet
 * rather than claim a ready it cannot see.
 */
export type PrHealth = "failing" | "running" | "ready" | "quiet";

function healthOf(pr: PullRequest, checks: readonly SavedCheck[], failing: number): PrHealth {
  if (pr.status !== "open") return "quiet";
  if (failing > 0) return "failing";
  if (checks.some((c) => c.state === "pending")) return "running";
  return checks.length > 0 && !pr.draft && pr.mergeable === true ? "ready" : "quiet";
}

// The chip's words after the number, joined by " · ": a draft keeps its
// marker whatever its health, and a PR that is not open says its status.
function wordsOf(pr: PullRequest, health: PrHealth, failing: number): string[] {
  if (pr.status !== "open") return pr.status ? [pr.status] : [];
  const words = pr.draft ? ["draft"] : [];
  if (health === "failing") words.push(failing + " failing");
  else if (health !== "quiet") words.push(health);
  return words;
}

/** Everything a view shows of a workspace's first PR. */
export interface PrSummary {
  number: number;
  status: PrStatus | undefined;
  url: string | undefined;
  health: PrHealth;
  /** An open draft, so the chip can take the draft colour. */
  draft: boolean;
  /** The number alone, "#12", for the row density so rows do not widen. */
  tag: string;
  /** The full words: "#35 · 1 failing", "#9 · draft · running", "#35 · ready", "#11 · merged". */
  text: string;
}

/** The workspace's first PR as a view shows it; undefined without a numbered PR. */
export function prSummary(w: Workspace | undefined): PrSummary | undefined {
  const pr = prOf(w);
  if (!w || !pr?.number) return undefined;
  const checks = checksOf(w);
  const failing = checks.filter((c) => c.state === "fail").length;
  const health = healthOf(pr, checks, failing);
  const tag = "#" + pr.number;
  const text = [tag, ...wordsOf(pr, health, failing)].join(" · ");
  const draft = pr.status === "open" && pr.draft === true;
  return { number: pr.number, status: pr.status, url: pr.url, health, draft, tag, text };
}
