// A workspace's pull requests: cmux's own when it sends any, else the one
// scripts/pr-poll.ts saved in config/state.json (issue #7). cmux sends custom
// sidebars no PR data today, so the saved copy is what shows; both sidebars
// read PRs through here so the day cmux does send them, its data wins.

import type { SavedCheck, SavedOwnPr, SavedPr, SavedPrOrigin } from "../../scripts/state-config.ts";
import { SAVED_STATE } from "./persist.ts";
import { cleanTitle } from "./text.ts";

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

/**
 * Which chat opened the PR at `url` (State.prOrigins, from report-pr.ts;
 * report-mention.ts adds what it first said, which nothing shows yet);
 * undefined for a PR no agent opened through the hook.
 */
export function originOf(url: string | undefined): SavedPrOrigin | undefined {
  // A test can seed __STATE__ from before this map existed, so it may be
  // missing at runtime even though State says it is not.
  const map: Record<string, SavedPrOrigin> | undefined = SAVED_STATE.prOrigins;
  return url && map && Object.hasOwn(map, url) ? map[url] : undefined;
}

/** The workspace's first PR, if any. */
export const prOf = (w: Workspace | undefined): PullRequest | undefined => (w ? prsOf(w)[0] : undefined);

/**
 * Whether the workspace's PRs are the poller's saved copy rather than
 * cmux's own, so they age with the poller's data (issue #78).
 */
export const fromPoller = (w: Workspace): boolean => !(w.prs?.length || w.pr);

/**
 * The CI checks of the saved PR, in checksFrom's order. Only the poller
 * saves checks, so while cmux sends a PR of its own there are none.
 */
export function checksOf(w: Workspace): SavedCheck[] {
  if (!fromPoller(w)) return [];
  return savedFor(w)?.checks ?? [];
}

/**
 * What a PR's chip says about the PR, so a problem shows without selecting
 * the workspace. Only an open PR has a health, its worst state: failing
 * checks, then merge conflicts, then checks running. Ready needs GitHub's
 * own verdict (mergeable, so no conflicts or blocking review) on a PR out
 * of draft whose saved checks all passed. With no saved checks (cmux's own
 * PR, one of Jon's own PRs no workspace holds, or a repo without CI), or an
 * entry saved before the poller kept the verdict, it stays quiet rather
 * than claim a ready it cannot see.
 */
export type PrHealth = "failing" | "conflicts" | "running" | "ready" | "quiet";

function healthOf(pr: PullRequest, checks: readonly SavedCheck[], failing: number): PrHealth {
  if (pr.status !== "open") return "quiet";
  if (failing > 0) return "failing";
  if (pr.conflicts === true) return "conflicts";
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

/** Everything a view shows of a PR. */
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
  /**
   * The words without the number, for a chip that sits beside it: "1 failing",
   * "draft · running", "conflicts", "ready", and a quiet open PR's "open".
   */
  state: string;
  /** The PR's own title, display-cleaned; "" when it has none. */
  title: string;
}

/**
 * A PR as a view shows it, with the checks saved for it; undefined without
 * a number. The one reading both sidebars use, so a chip says the same
 * wherever it is.
 */
export function summaryOf(pr: PullRequest, checks: readonly SavedCheck[]): PrSummary | undefined {
  if (!pr.number) return undefined;
  const failing = checks.filter((c) => c.state === "fail").length;
  const health = healthOf(pr, checks, failing);
  const words = wordsOf(pr, health, failing);
  const tag = "#" + pr.number;
  const text = [tag, ...words].join(" · ");
  const state = words.join(" · ") || (pr.status ?? "");
  const draft = pr.status === "open" && pr.draft === true;
  const title = cleanTitle(pr.title);
  return { number: pr.number, status: pr.status, url: pr.url, health, draft, tag, text, state, title };
}

/** The health of the workspace's first numbered PR, without the words; quiet with none. */
export function prHealth(w: Workspace | undefined): PrHealth {
  const pr = prOf(w);
  if (!w || !pr?.number) return "quiet";
  const checks = checksOf(w);
  return healthOf(pr, checks, checks.filter((c) => c.state === "fail").length);
}

/** The workspace's first PR as a view shows it; undefined without a numbered PR. */
export function prSummary(w: Workspace | undefined): PrSummary | undefined {
  const pr = prOf(w);
  return w && pr ? summaryOf(pr, checksOf(w)) : undefined;
}
