// A workspace's pull requests: cmux's own when it sends any, else the one
// scripts/pr-poll.ts saved in config/state.json (issue #7). cmux sends custom
// sidebars no PR data today, so the saved copy is what shows; both sidebars
// read PRs through here so the day cmux does send them, its data wins.

import type { SavedCheck, SavedOwnPr, SavedPr, SavedPrOrigin } from "../../scripts/state-config.ts";
import { SAVED_STATE } from "./persist.ts";
import { healthOf, type PrHealth } from "./pr-health.ts";
import { cleanTitle } from "./text.ts";

export type { PrHealth } from "./pr-health.ts";

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
 * Which chat opened the PR at `url` (State.prOrigins, from report-pr.ts);
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
  /** Its diff size, "+120 −8" (diffText); "" when it has none. */
  diff: string;
}

// A count in at most four characters, never rounded up: 950, 1.2k, 12k, 3.4M.
function lines(n: number): string {
  if (n < 1000) return String(n);
  const [scaled, unit] = n < 1e6 ? [n / 1e3, "k"] : [n / 1e6, "M"];
  if (scaled >= 1000) return "999M";
  return (scaled < 10 ? String(Math.floor(scaled * 10) / 10) : String(Math.floor(scaled))) + unit;
}

/**
 * An open PR's diff size as "+120 −8" (a true minus sign). "" once it is
 * merged or closed, since the size is a cue for review; "" unless both
 * counts are known, so a missing one is never shown as 0; and "" for an
 * empty diff, which has nothing to say.
 */
export function diffText(pr: Pick<PullRequest, "status" | "additions" | "deletions">): string {
  const { additions: add, deletions: del } = pr;
  if (pr.status !== "open" || add === undefined || del === undefined) return "";
  return add || del ? "+" + lines(add) + " −" + lines(del) : "";
}

/**
 * A PR as a view shows it, with the checks saved for it; undefined without
 * a number. The one reading both sidebars use, so a chip says the same
 * wherever it is.
 */
export function summaryOf(pr: PullRequest, checks: readonly SavedCheck[]): PrSummary | undefined {
  if (!pr.number) return undefined;
  const failing = checks.filter((c) => c.state === "fail").length;
  const health = healthOf(pr, checks);
  const words = wordsOf(pr, health, failing);
  const tag = "#" + pr.number;
  const text = [tag, ...words].join(" · ");
  const state = words.join(" · ") || (pr.status ?? "");
  const title = cleanTitle(pr.title);
  return { number: pr.number, status: pr.status, url: pr.url, health, tag, text, state, title, diff: diffText(pr) };
}

/** The health of the workspace's first numbered PR, without the words; quiet with none. */
export function prHealth(w: Workspace | undefined): PrHealth {
  const pr = prOf(w);
  if (!w || !pr?.number) return "quiet";
  const checks = checksOf(w);
  return healthOf(pr, checks);
}

/** The workspace's first PR as a view shows it; undefined without a numbered PR. */
export function prSummary(w: Workspace | undefined): PrSummary | undefined {
  const pr = prOf(w);
  return w && pr ? summaryOf(pr, checksOf(w)) : undefined;
}
