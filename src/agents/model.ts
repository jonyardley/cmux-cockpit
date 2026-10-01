// The agents panel's data: the selected workspace in detail (and its
// question, when its agent needs you), every PR, and what agents published.
// Who is working and who is idle lives on the cockpit's cards, not here.
// Pure reads of `data`, so each is testable alone.

import { byActivity } from "../shared/activity.ts";
import { prFreshness } from "../shared/freshness.ts";
import { agentsOf, askReason } from "../shared/needs.ts";
import { STATUS_TEXT } from "../shared/palette.ts";
import { type Project, projectOf, savedProjectFor } from "../shared/projects.ts";
import { fromPoller, type PrSummary, prSummary } from "../shared/prs.ts";
import { quietSuffix } from "../shared/quiet.ts";
import { cardMessage, promptText } from "../shared/text.ts";
import { ageSince, finishedAt, nowEpoch } from "../shared/time.ts";
import { type HaloStatus, haloColor } from "../shared/ui.ts";
import { ASKING_WORD, NO_AGENT_WORD, STATUS_WORD, withAge } from "../shared/words.ts";
import { STATUS_DOT, T } from "./theme.ts";

// ---- This workspace -------------------------------------------------------
// This panel has no author state of its own (a sidebar cannot see another
// sidebar's), so it follows selection instead.

export interface Current {
  ws: Workspace;
  a: Agent | null;
  /** Most active first. */
  agents: Agent[];
  /** The same agents in cmux's own order. */
  inOrder: Agent[];
  project: Project;
}

export const current = computed((): Current | null => {
  const w = (data.workspaces() ?? []).find((x) => x.selected);
  if (!w) return null;
  const inOrder = agentsOf(w);
  const agents = [...inOrder].sort(byActivity);
  return { ws: w, a: agents[0] ?? null, agents, inOrder, project: savedProjectFor(w.directory, w.id) };
});

/** The This workspace heading, with the selected workspace's project:
 * "THIS WORKSPACE · Cockpit"; plain "THIS WORKSPACE" with no project. The
 * workspace's own name is left to the highlighted card on the left. */
export const currentHeading = computed((): string => {
  const name = current()?.project.name;
  return name ? "THIS WORKSPACE · " + name : "THIS WORKSPACE";
});

/** current(), or an empty stand-in so views never branch on null. */
export const cur = (): Current =>
  current() ?? { ws: { id: "" }, a: null, agents: [], inOrder: [], project: projectOf("") };

/** The selected workspace's open question. */
export interface Ask {
  /** The most active asking agent: Open chat focuses its terminal. */
  a: Agent;
  /** The line over the buttons: "2 agents need you" when several do,
   * else why it is asking ("allow git push?"), else the agent's words, or
   * "" when there are none beyond the generic "waiting for your reply", or
   * when they may be another agent's. */
  text: string;
  /** How many agents in the workspace are asking. */
  count: number;
  /** Open chat shows only with a terminal to focus: without one it would only
   * select the workspace, which is already selected. */
  canOpenChat: boolean;
  /** Dismiss clears every ask in the workspace, so it says so when there are several. */
  dismissLabel: string;
}

// The workspace's latestMessage is workspace-wide (Agent carries no message
// of its own), so it is the asker's words only when no other live agent
// could have written it.
function askText(c: Current, count: number): string {
  if (count > 1) return `${count} agents need you`;
  const reason = askReason(c.a, c.ws);
  if (reason) return reason;
  const live = c.agents.filter((a) => a.status !== "ended").length;
  return live === 1 ? cardMessage(c.ws) : "";
}

/** Whether the selected workspace needs you, by the Needs you strip's rule:
 * its most active agent reads needs_input once nudges and dismissals are
 * applied (src/shared/needs.ts). Null otherwise. */
export const currentAsk = computed((): Ask | null => {
  const c = current();
  if (c?.a?.status !== "needs_input") return null;
  const count = c.agents.filter((a) => a.status === "needs_input").length;
  return {
    a: c.a,
    text: askText(c, count),
    count,
    canOpenChat: !!c.a.surfaceId,
    dismissLabel: count > 1 ? "Dismiss all" : "Dismiss",
  };
});

/** The card's quiet message line; empty while the question block shows the words. */
export const cardLine = computed((): string => (currentAsk() ? "" : cardMessage(cur().ws)));

/** The card's Asked line: the last prompt Jon gave, above the agent's last
 * message (issue #80), kept through a harness turn (shared/text.ts). */
export const askedLine = computed((): string => promptText(cur().ws));

/** Idle and no agent draw a hollow ring, as the left sidebar does. */
export const hollowDot = (a: Agent | null): boolean => !a || a.status === "idle";

// The halo colour for each of shared/ui.ts's two haloed statuses; every
// other status reads "clear" (haloColor falls back to it via haloStatus),
// matching the left sidebar's status.ts.
const HALO_COLOR: Record<HaloStatus, string> = { working: T.blueHalo, needs_input: T.clayHalo };

// Whether `a`, one of `w`'s agents (the selected workspace's by default),
// is asking rather than waiting for its turn (issue #81).
const isAsking = (a: Agent | null, w: Workspace): boolean => askReason(a, w) !== null;

/** Board 1's soft halo round a live dot: working and needs only, as the left
 * sidebar rings them, amber while the agent is asking. */
export const haloFor = (a: Agent | null, w: Workspace = cur().ws): string =>
  isAsking(a, w) ? T.amberHalo : haloColor(a?.status, HALO_COLOR);

/** An agent's dot: its status colour, amber while asking, grey without one. */
export function dotFor(a: Agent | null, w: Workspace = cur().ws): string {
  if (!a) return T.grey;
  return isAsking(a, w) ? T.amber : (a.status && STATUS_DOT[a.status]) || T.grey;
}

/** The card head's status colour, amber while asking. */
export function statusColor(a: Agent | null, w: Workspace = cur().ws): string {
  if (!a) return T.secondary;
  return isAsking(a, w) ? T.amberText : (a.status && STATUS_TEXT[a.status]) || T.secondary;
}

// Idle and ended agents count from when they finished (issue #98), as the
// cockpit's cards do; the rest from the start of their current status.
function statusSince(a: Agent): number | undefined {
  return a.status === "idle" || a.status === "ended" ? finishedAt(a) : (a.sinceEpoch ?? a.lastActivityAt);
}

/** Short form for agent rows, the card head's words in lower case: "working 12m", "finished 3m". */
export function statusLine(a: Agent | null, w: Workspace = cur().ws): string {
  return a ? withAge(statusWord(a, w).toLowerCase(), sinceAge(a)) : "";
}

/** The one age format the card shows: "<1m", "12m", counted from the
 * start of the status (idle and ended from when they finished); "" without
 * an agent or a timestamp. */
export function sinceAge(a: Agent | null): string {
  return a ? ageSince(statusSince(a)) : "";
}

/** The card head's status, in the words the cockpit uses: "Working 14m", "Asking 2m", "Finished 3m", "No agent". */
export function headStatus(a: Agent | null, w: Workspace = cur().ws): string {
  return a ? withAge(statusWord(a, w), sinceAge(a)) + quietSuffix(a, w) : NO_AGENT_WORD;
}

// The shared word for the agent's status, Asking while it asks.
const statusWord = (a: Agent, w: Workspace): string =>
  isAsking(a, w) ? ASKING_WORD : a.status ? (STATUS_WORD[a.status] ?? a.status) : NO_AGENT_WORD;

// The card's details

/** The card's faint footer: the branch, then "uncommitted changes" when
 * dirty, or "clean" only when cmux says it is ("main · clean"); the branch
 * alone when cmux does not say, the changes alone with no branch, and ""
 * with neither. cmux sends no file count, so it never says how many. */
export const branchFooter = computed((): string => {
  const w = cur().ws;
  const state = w.dirty ? "uncommitted changes" : w.dirty === false ? "clean" : "";
  return [w.branch, state].filter(Boolean).join(" · ");
});

export interface PortChip {
  key: string;
  label: string;
  url: string;
}

/** The workspace's open ports, at most three, each opening its local page. */
export const portChips = computed((): PortChip[] =>
  (cur().ws.ports ?? []).slice(0, 3).map((n) => ({ key: "p" + n, label: ":" + n, url: "http://localhost:" + n })),
);

/** The workspace's PR with its state, as the chip shows it. */
export const currentPr = computed((): PrSummary | undefined => prSummary(cur().ws));

/** The saved PR data's freshness (shared/freshness.ts) at the clock, worked
 * out once a tick for every row, the card chip and the heading's line. */
export const freshness = computed(() => prFreshness(nowEpoch()));

export const prStale = (): boolean => freshness().stale;

/** The workspace's PR chip dims while it is the poller's copy and that copy is stale. */
export const currentPrDim = computed((): boolean => !!currentPr() && fromPoller(cur().ws) && prStale());
