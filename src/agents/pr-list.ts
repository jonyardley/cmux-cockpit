// The panel's Pull requests list: every PR, and which chat each belongs to.
// Pure reads of `data`, so each is testable alone.

import { mostActive } from "../shared/activity.ts";
import { placeholderIds } from "../shared/anchors.ts";
import type { Last } from "../shared/list.ts";
import { agentsOf } from "../shared/needs.ts";
import { type Project, savedProjectFor } from "../shared/projects.ts";
import {
  checksOf,
  fromPoller,
  originOf,
  type PrHealth,
  type PrSummary,
  prSummary,
  prsOf,
  savedOwnPrs,
  summaryOf,
} from "../shared/prs.ts";
import { displayTitle } from "../shared/titles.ts";
import { footText, isExpanded, markLastBefore, moreThan } from "./lists.ts";

import { dotFor, freshness, hollowDot, prStale } from "./model.ts";

// ---- Pull requests ----------------------------------------------------------

export interface PrEntry {
  key: string;
  pr: PullRequest;
  title: string;
  /** The PR as the cards read it (shared/prs.ts), so the chip says the same on both sides. */
  summary: PrSummary | undefined;
  /** The poller's saved copy rather than cmux's own, so it can go stale. */
  saved: boolean;
  /** Its project, from the session's folder, else the repo an own PR was
   * found in; grey when neither matches one. */
  project: Project;
  /** The session it belongs to; undefined when none holds or opened it, or that chat has closed. */
  session: PrSession | undefined;
}

/** Where a row's Open chat goes: the workspace, and its lead agent's
 * surface when it has one (views/parts.ts jump). */
export interface ChatTarget {
  wsId: string;
  surfaceId: string | undefined;
}

/** The workspace a row's right-click Open chat goes to, by id; none for the
 * selected workspace with no terminal to focus, where it would do nothing
 * (as canOpenChat). */
export function chatWs(w: Workspace, lead: Agent | null): string | undefined {
  return w.selected && !lead?.surfaceId ? undefined : w.id;
}

/** Where Open chat jumps, read when it is chosen, so it focuses the agent the
 * panel leads with then; none once the workspace has gone. */
export function chatTarget(wsId: string): ChatTarget | undefined {
  const w = (data.workspaces() ?? []).find((x) => x.id === wsId);
  return w ? { wsId, surfaceId: mostActive(agentsOf(w))?.surfaceId } : undefined;
}

/** The chat a PR row names on its faint line, with that chat's status dot. */
export interface PrSession {
  name: string;
  /** The workspace the row's right-click Open chat goes to (chatWs). */
  chat: string | undefined;
  dot: string;
  /** Idle or no agent: the dot draws as a hollow ring, as everywhere else in the panel. */
  hollow: boolean;
  /** The selected workspace: its row is tinted and sorts first (issue #183). */
  here: boolean;
}

/** This chat's own PR: the panel tints its row (issue #183). */
export const isHerePr = (e: Pick<PrEntry, "session">): boolean => e.session?.here ?? false;

/**
 * Whether a PR row leads the list: one of this chat's that is open, or the
 * one its card shows (`cardUrl`), whatever its state. A chat's older merged
 * or closed PRs stay in their place, so they never push open PRs out of the
 * folded cut.
 */
export const leadsList = (e: Pick<PrEntry, "session" | "pr">, cardUrl: string | undefined): boolean =>
  isHerePr(e) && (e.pr.status === "open" || (!!cardUrl && e.pr.url === cardUrl));

/** A PR row's number, "#134"; "" before GitHub has given it one. */
export const prNumberText = (e: Pick<PrEntry, "pr">): string => (e.pr.number ? "#" + e.pr.number : "");

/**
 * What a PR row's chip says: the PR's worst state as its card says it
 * ("1 failing", "conflicts", "draft · running", "ready", "open", "merged"),
 * or for a PR with no number, "draft" for an open draft, else its status.
 * Stale rides inside the chip, since an empty sibling Text would still cost spacing.
 */
export function prChipText(e: Pick<PrEntry, "pr" | "summary">): string {
  const { pr, summary } = e;
  const word = summary ? summary.state : pr.status === "open" && pr.draft ? "draft" : pr.status;
  return [word, pr.stale ? "stale" : undefined].filter(Boolean).join(" · ");
}

/** A PR row chip's health, for its colour. */
export const prChipHealth = (e: Pick<PrEntry, "summary">): PrHealth => e.summary?.health ?? "quiet";

// A PR with no status ranks as open: only cmux sends one, for a PR a
// workspace holds now, and the poller's own PRs always carry theirs.
const PR_RANK: Record<PrStatus, number> = { open: 0, merged: 1, closed: 2 };
const prRank = (pr: PullRequest): number => (pr.status ? PR_RANK[pr.status] : 0);

// A real label (it is often just "PR"), else the branch, else the
// workspace's title. The label and branch come first because the row's faint
// line already names the workspace.
function prTitle(w: Workspace, pr: PullRequest): string {
  const label = String(pr.label || "").trim();
  return (/^pr$/i.test(label) ? "" : label) || pr.branch || displayTitle(w) || "";
}

// Every PR, open first then merged then closed. Within each state the PRs
// workspaces hold come before Jon's own that no workspace holds, newest first
// in each, so a merged or closed workspace PR can never push his open PRs out
// of the cut to MAX_PRS. Open workspace PRs still can. Ahead of all of them
// go this chat's leads (issue #183): its card's PR and its other open ones.
const allPrs = computed((): PrEntry[] => {
  const seen = new Set<string>();
  const all = data.workspaces() ?? [];
  // A lane's placeholder is no chat (shared/anchors.ts): a PR cmux pins on it
  // is dropped, and an own PR its agent opened names no session.
  const placeholders = placeholderIds(data.groups() ?? [], new Map(all.map((w) => [w.id, w])));
  const workspaces = all.filter((w) => !placeholders.has(w.id));
  const held = workspacePrs(workspaces, seen);
  const own = ownPrs(new Map(workspaces.map((w) => [w.id, w])), seen);
  const isOwn = new Set(own.map((e) => e.key));
  const cardUrl = prSummary(all.find((w) => w.selected))?.url;
  const leads = (e: PrEntry): number => Number(leadsList(e, cardUrl));
  return [...held, ...own].sort(
    (x, y) =>
      leads(y) - leads(x) ||
      prRank(x.pr) - prRank(y.pr) ||
      Number(isOwn.has(x.key)) - Number(isOwn.has(y.key)) ||
      (y.pr.number ?? 0) - (x.pr.number ?? 0),
  );
});

// Every workspace's PRs, once each, noting their urls in `seen`.
function workspacePrs(workspaces: readonly Workspace[], seen: Set<string>): PrEntry[] {
  const out: PrEntry[] = [];
  for (const w of workspaces) {
    for (const pr of prsOf(w)) {
      if (!pr?.url || seen.has(pr.url)) continue;
      seen.add(pr.url);
      const summary = summaryOf(pr, checksOf(w));
      // The PR's own title when the poller saved one, as an own PR's row has.
      const title = summary?.title || prTitle(w, pr);
      out.push({
        key: pr.url,
        pr,
        title,
        summary,
        saved: fromPoller(w),
        project: savedProjectFor(w.directory, w.id),
        session: sessionOf(w),
      });
    }
  }
  return out;
}

// Jon's own open PRs not in `seen`. No workspace holds one, so the chat that
// opened it, while still open, names its session and project; else its repo does.
function ownPrs(byId: ReadonlyMap<string, Workspace>, seen: Set<string>): PrEntry[] {
  const out: PrEntry[] = [];
  for (const o of savedOwnPrs()) {
    if (seen.has(o.url)) continue;
    seen.add(o.url);
    const pr: PullRequest = { number: o.number, url: o.url, status: o.status, branch: o.branch };
    if (o.draft) pr.draft = true;
    const opener = byId.get(originOf(o.url)?.workspace ?? "");
    out.push({
      key: o.url,
      pr,
      title: o.title,
      summary: summaryOf(pr, []),
      saved: true,
      project: savedProjectFor(opener?.directory ?? o.repo, opener?.id),
      session: opener ? sessionOf(opener) : undefined,
    });
  }
  return out;
}

/** PR rows shown at most while the card is folded. */
const MAX_PRS = 5;

/** Every PR, before the cap, for the heading's count. */
export const prCount = computed((): number => allPrs().length);

// How many PRs the cap leaves out while the card is folded.
const prOver = computed((): number => moreThan(prCount(), MAX_PRS));

/** The Pull requests card's closing line, from footText. */
export const prFoot = computed((): string => footText(prOver(), isExpanded("prs")));

/** The Pull requests rows, at most MAX_PRS unless the card is open. While
 * the list overflows, a closing line follows, so no row is last. */
export const prs = computed((): Last<PrEntry>[] => {
  const all = allPrs();
  return markLastBefore(isExpanded("prs") ? all : all.slice(0, MAX_PRS), prOver());
});

/** The faint line under the Pull requests heading when the saved data is old
 * or gh is down, "gh unavailable · last checked 2h ago"; "" when fresh. */
export const prNote = computed((): string => freshness().line);

/** A PR row's chip dims while it is the poller's copy and that copy is stale. */
export const prDim = (e: Pick<PrEntry, "saved">): boolean => e.saved && prStale();

// ---- Which session a PR belongs to ------------------------------------------
// A row's faint line names the chat that holds the PR, else the one that
// opened it (report-pr.ts), with its status dot; a tap on the row opens the
// PR on GitHub.

/** "This chat" for the selected workspace, else its name, and its lead agent's dot. */
function sessionOf(w: Workspace): PrSession {
  const lead = mostActive(agentsOf(w));
  const here = !!w.selected;
  const name = here ? "This chat" : displayTitle(w) || "Another chat";
  return { name, dot: dotFor(lead, w), hollow: hollowDot(lead), chat: chatWs(w, lead), here };
}
