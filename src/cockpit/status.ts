// A workspace's status, from its most active agent, with idle nudges and
// "needs you" dismissals applied (src/shared/needs.ts).

import type { SavedMove } from "../../scripts/state-config.ts";
import { mostActive } from "../shared/activity.ts";
import { waitingMove } from "../shared/move.ts";
import { agentsOf, askReason, hasRealAsk } from "../shared/needs.ts";
import { STATUS_TEXT } from "../shared/palette.ts";
import { prInk } from "../shared/pr-colors.ts";
import type { PrSummary } from "../shared/prs.ts";
import { quietSince, quietSuffix } from "../shared/quiet.ts";
import { liveRunCount } from "../shared/subagents.ts";
import { cardMessage, clip, oneLine, promptText, readable } from "../shared/text.ts";
import { ageSince, finishedAt } from "../shared/time.ts";
import { type HaloStatus, haloColor, type PillColors, QUIET_PILL } from "../shared/ui.ts";
import { ASKING_WORD, NO_AGENT_WORD, STATUS_WORD, withAge, YOU_WORD } from "../shared/words.ts";
import { isSelected } from "./state.ts";
import { C } from "./theme.ts";

export type Status = AgentStatus | "none";

export function agentOf(w: Workspace | undefined): Agent | null {
  return mostActive(agentsOf(w));
}

export function statusOf(w: Workspace | undefined): Status {
  return agentOf(w)?.status ?? "none";
}

/** When the current status began: agent start, else its activity, else the workspace's. */
export function sinceOf(w: Workspace | undefined): number {
  const a = agentOf(w);
  if (a?.sinceEpoch) return a.sinceEpoch;
  if (a?.lastActivityAt) return a.lastActivityAt;
  return w?.latestAt || 0;
}

export function ageOf(w: Workspace | undefined): string {
  return ageSince(sinceOf(w));
}

/**
 * How urgent a workspace is for its header's count pill, ranked needs you,
 * asking, working (quiet or not), then quiet: finished, idle and no agent.
 */
export type Urgency = "needs" | "asking" | "working" | "quiet";

export interface StatusStyle {
  label: string;
  dot: string | null;
  /** Board 1's soft halo round a live dot: working and needs only. */
  halo: string;
  text: string;
  /** The ring round a hollow dot; grey when unset. */
  ring?: string;
  /** What the style means for a header's count pill, so the pill and the dot cannot disagree. */
  urgency: Urgency;
}

// The halo colour for each of shared/ui.ts's two haloed statuses; every
// other status reads "clear" (haloColor falls back to it via haloStatus).
const HALO_COLOR: Record<HaloStatus, string> = { working: C.blueHalo, needs_input: C.clayHalo };

// Words from shared/words.ts and text colours from shared/palette.ts, so a
// status reads the same in the agents panel.
const STATUS_URGENCY: Record<AgentStatus, Urgency> = {
  needs_input: "needs",
  working: "working",
  idle: "quiet",
  ended: "quiet",
};

const style = (s: AgentStatus, dot: string | null): StatusStyle => ({
  label: STATUS_WORD[s],
  dot,
  halo: haloColor(s, HALO_COLOR),
  text: STATUS_TEXT[s],
  urgency: STATUS_URGENCY[s],
});

const STATUS: Record<Status, StatusStyle> = {
  working: style("working", C.blue),
  needs_input: style("needs_input", C.clay),
  idle: style("idle", null),
  ended: style("ended", C.green),
  none: { label: NO_AGENT_WORD, dot: null, halo: haloColor("none", HALO_COLOR), text: C.faint, urgency: "quiet" },
};

// Ready: finished and not yet looked at (issue #53).

const FINISHED: ReadonlySet<Status> = new Set<Status>(["idle", "ended"]);

/**
 * The agent whose finish a Ready card reports: of the agents that settled on
 * idle or ended after working (cmux recorded activity), the latest active,
 * the same tie-break both sidebars use to pick a workspace's agent. Not
 * simply the most active one, which ranks a fresh idle session that never
 * worked above an ended one that did. Its age counts from finishedAt.
 */
function finishedAgent(w: Workspace): Agent | null {
  let best: Agent | null = null;
  for (const a of agentsOf(w)) {
    if (!FINISHED.has(a.status) || !((a.lastActivityAt ?? 0) > 0)) continue;
    if (!best || (a.lastActivityAt ?? 0) > (best.lastActivityAt ?? 0)) best = a;
  }
  return best;
}

/**
 * The agent finished while Jon was elsewhere: no agent is working or asking,
 * one settled on idle or ended after working (a Claude idle nudge counts,
 * since agentsOf reads it as idle), and the workspace holds output he has
 * not read. Opening the workspace clears it: cmux marks it read, and a
 * selected workspace (a tap shows at once) is being looked at anyway. A
 * real ask is never Ready, even one dismissed from Needs you: the agent
 * stopped to ask, it did not finish. The unread check comes first, so the
 * many cards with nothing unread cost one field read.
 */
export function isReady(w: Workspace | undefined): boolean {
  return readyAgent(w) !== null;
}

/** The agent a Ready card reports, or null when the workspace is not Ready. */
export function readyAgent(w: Workspace | undefined): Agent | null {
  if (!w || !((w.unread ?? 0) > 0) || isSelected(w) || hasRealAsk(w)) return null;
  return FINISHED.has(statusOf(w)) ? finishedAgent(w) : null;
}

// The finished green and word: Ready adds no hue or word of its own.
const READY: StatusStyle = { ...STATUS.ended, halo: "clear" };

// Asking (issue #81): needs_input because the agent stopped on a
// permission or a question, not because its turn ended.
const ASKING: StatusStyle = {
  label: ASKING_WORD,
  dot: C.amber,
  halo: C.amberHalo,
  text: C.amberText,
  urgency: "asking",
};

/** Why the workspace's agent is asking ("allow git push?"), or null when it is not (shared/needs.ts). */
export const askOf = (w: Workspace | undefined): string | null => askReason(agentOf(w), w);

// Quiet: still working, but silent a while. Blue keeps its one meaning, so
// the dot goes hollow in blue rather than taking a new hue.
const QUIET: StatusStyle = { ...STATUS.working, dot: null, halo: "clear", ring: C.blue };

export function statusInfo(w: Workspace | undefined): StatusStyle {
  if (isReady(w)) return READY;
  // The agent is worked out once, for both the ask and the status.
  const a = agentOf(w);
  if (askReason(a, w)) return ASKING;
  if (quietSince(a, w)) return QUIET;
  return STATUS[a?.status ?? "none"] ?? STATUS.none;
}

// A header's count pill takes the hue of its most urgent session: needs
// you, then asking, then working. Finished, idle and no agent leave it grey.

const URGENCY_RANK: readonly Urgency[] = ["needs", "asking", "working", "quiet"];

const COUNT_TINT: Record<Urgency, PillColors> = {
  needs: { bg: C.clayCount, fg: C.clayText },
  asking: { bg: C.amberCount, fg: C.amberText },
  working: { bg: C.blueCount, fg: C.blueText },
  quiet: QUIET_PILL,
};

/** A workspace's urgency: the one its card's status (statusInfo) carries. */
export const urgencyOf = (w: Workspace | undefined): Urgency => statusInfo(w).urgency;

/**
 * The first of the workspaces at the highest urgency above quiet, or
 * undefined when all are quiet: whose dot a folded header shows. Stops at
 * the first needs you, since nothing ranks above it.
 */
export function mostUrgentOf(ws: readonly Workspace[]): Workspace | undefined {
  let best = URGENCY_RANK.length - 1;
  let lead: Workspace | undefined;
  for (const w of ws) {
    const rank = URGENCY_RANK.indexOf(urgencyOf(w));
    if (rank >= best) continue;
    best = rank;
    lead = w;
    if (best === 0) break;
  }
  return lead;
}

/** The most urgent of the workspaces' urgencies; quiet with none. */
export const mostUrgent = (ws: readonly Workspace[]): Urgency => urgencyOf(mostUrgentOf(ws));

/** A count pill's colours for the workspaces it counts: its most urgent session's hue, else grey. */
export const countColors = (ws: readonly Workspace[]): PillColors => COUNT_TINT[mostUrgent(ws)];

/** What a lane or project header shows beside its count. */
export interface HeaderStatus {
  tint: PillColors;
  /** Whose dot shows while folded: none while open or all quiet. */
  dot: Workspace | undefined;
}

/** A header's pill tint and, folded, its lead's dot, from one walk over its cards. */
export function headerStatus(ws: readonly Workspace[], folded: boolean): HeaderStatus {
  const lead = mostUrgentOf(ws);
  return { tint: COUNT_TINT[urgencyOf(lead)], dot: folded ? lead : undefined };
}

/** The "Your move" line the workspace's chat ended its turn on, while that turn is still waiting on Jon. */
export function moveOf(w: Workspace | undefined): SavedMove | null {
  const a = agentOf(w);
  return waitingMove(a, w, !!askReason(a, w));
}

/** A Needs you row's second line: why the agent asks, else what it wants, else its latest message. */
export const needsDetail = (w: Workspace | undefined): string =>
  askOf(w) ?? (clip(moveOf(w)?.text ?? "", 80) || oneLine(cardMessage(w), 80) || "Waiting for your reply");

/** A Needs you row's edge: amber while its agent asks, else clay, so each hue keeps one meaning. */
export const needsRowEdge = (w: Workspace | undefined): string => (askOf(w) ? C.amberRowEdge : C.needsRowEdge);

/** The unread count a card's badge shows: none while the Ready pill stands in for it. */
export const badgeCount = (w: Workspace | undefined): number => (isReady(w) ? 0 : (w?.unread ?? 0));

/**
 * The PR as text in a compact card's status line ("· #45 · 1 failing"), else
 * "". Compact cards have no chips, so this is where their PR shows, Ready or
 * not. The full card says nothing about the PR in its status row: the PR
 * chip at the head of its chips row carries the verdict (issue #79).
 */
export function compactPrText(pr: Pick<PrSummary, "text"> | undefined): string {
  const t = pr?.text;
  return t ? "· " + t : "";
}

/**
 * A PR written as text (compact and row densities): its health's colour
 * when it has something to say, else the density's own quiet colour.
 */
export function prTextColor(pr: Pick<PrSummary, "health"> | undefined, quiet: string): string {
  return !pr || pr.health === "quiet" ? quiet : prInk(pr.health);
}

// --- the card's second line (issue #47) ----------------------------------------------

/** The status and how long it has held ("Working 14m", "Finished 6m").
 * A Ready card counts from when its finished agent finished, and an idle
 * or ended card from when its agent finished, by the rule the agents panel
 * uses (issue #98). Otherwise only the agent's sinceEpoch says when the
 * status began; sinceOf's fallbacks (last activity, the workspace's
 * latestAt) do not, so without it the time is left off. */
export function statusLine(w: Workspace | undefined): string {
  const info = statusInfo(w);
  const line = withAge(info.label, cardAge(w));
  return info === QUIET ? line + quietSuffix(agentOf(w), w) : line;
}

/**
 * The card menu's PR item. A menu item cannot hide, so with no PR, or a PR
 * cmux gave no link for, it says so and its tap does nothing.
 */
export function openPrLabel(pr: Pick<PrSummary, "tag" | "url"> | undefined): string {
  if (!pr) return "No PR to open";
  return pr.url ? "Open PR " + pr.tag : "PR " + pr.tag + " has no link";
}

/** True when statusLine carries a time, so a card leaves its top-right one off. */
export const statusHasAge = (w: Workspace | undefined): boolean => cardAge(w) !== "";

function cardAge(w: Workspace | undefined): string {
  const ready = readyAgent(w);
  if (ready) return ageSince(finishedAt(ready));
  const a = agentOf(w);
  if (!a) return "";
  return ageSince(FINISHED.has(a.status) ? finishedAt(a) : a.sinceEpoch);
}

/** "· 3 helpers" while subagent runs are live, else "". */
export function helperText(w: Workspace | undefined): string {
  const n = liveRunCount(w);
  if (!n) return "";
  return "· " + n + (n === 1 ? " helper" : " helpers");
}

/** About two lines of card text at the full card's width. */
export const DETAIL_MAX = 140;

/** About one line of a compact card's text. */
const LEFT_OFF_MAX = 90;

/** "You: " and your last prompt, for a card that shows where you left off; "" with none. */
export function leftOffText(w: Workspace | undefined): string {
  const t = promptText(w);
  return t ? YOU_WORD + ": " + clip(t, LEFT_OFF_MAX) : "";
}

/**
 * What the waiting chat wants ("Run /clear now."), else the agent's latest
 * message (never a prompt echo), else the description. The move comes first
 * because cmux sends only the start of the message, and the move is its end.
 */
export function cardDetail(w: Workspace | undefined): string {
  // cardMessage is already readable(), so only the description needs it.
  return clip(moveOf(w)?.text || cardMessage(w) || readable(w?.description), DETAIL_MAX);
}

/**
 * The ink for a card's message line. The selected workspace's card keeps
 * its line, faded, since the agents panel on the right shows that message in
 * full: the line stays so the card keeps its height and nothing moves on a
 * tap. Every other card reads it in the secondary ink.
 */
export const detailColor = (selected: boolean): string => (selected ? C.faint : C.secondary);

/** The progress bar's fraction, held to 0 to 1; null when no value is sent. */
export function progressFraction(w: Workspace | undefined): number | null {
  const v = w?.progress?.value;
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  return Math.max(0, Math.min(1, v));
}
