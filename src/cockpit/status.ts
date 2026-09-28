// A workspace's status, from its most active agent, with idle nudges and
// "needs you" dismissals applied (src/shared/needs.ts).

import { mostActive } from "../shared/activity.ts";
import { agentsOf, askReason, hasRealAsk } from "../shared/needs.ts";
import { STATUS_TEXT } from "../shared/palette.ts";
import { prChipColors } from "../shared/pr-colors.ts";
import type { PrSummary } from "../shared/prs.ts";
import { liveRunCount } from "../shared/subagents.ts";
import { cardMessage, clip, oneLine, readable } from "../shared/text.ts";
import { finishedAt, fmtAge, nowEpoch } from "../shared/time.ts";
import { type HaloStatus, haloColor } from "../shared/ui.ts";
import { ASKING_WORD, NO_AGENT_WORD, STATUS_WORD, withAge } from "../shared/words.ts";
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
  const s = sinceOf(w);
  return s ? fmtAge(nowEpoch() - s) : "";
}

export interface StatusStyle {
  label: string;
  dot: string | null;
  /** Board 1's soft halo round a live dot: working and needs only. */
  halo: string;
  text: string;
}

// The halo colour for each of shared/ui.ts's two haloed statuses; every
// other status reads "clear" (haloColor falls back to it via haloStatus).
const HALO_COLOR: Record<HaloStatus, string> = { working: C.blueHalo, needs_input: C.clayHalo };

// Words from shared/words.ts and text colours from shared/palette.ts, so a
// status reads the same in the agents panel.
const style = (s: AgentStatus, dot: string | null): StatusStyle => ({
  label: STATUS_WORD[s],
  dot,
  halo: haloColor(s, HALO_COLOR),
  text: STATUS_TEXT[s],
});

const STATUS: Record<Status, StatusStyle> = {
  working: style("working", C.blue),
  needs_input: style("needs_input", C.clay),
  idle: style("idle", null),
  ended: style("ended", C.green),
  none: { label: NO_AGENT_WORD, dot: null, halo: haloColor("none", HALO_COLOR), text: C.faint },
};

// Ready: finished and not yet looked at (issue #53).

const FINISHED: ReadonlySet<Status> = new Set<Status>(["idle", "ended"]);

/**
 * The agent whose finish a Ready card reports: of the agents that settled on
 * idle or ended after working (cmux recorded activity), the one that
 * finished last. Not simply the most active one, which ranks a fresh idle
 * session that never worked above an ended one that did.
 */
function finishedAgent(w: Workspace): Agent | null {
  let best: Agent | null = null;
  for (const a of agentsOf(w)) {
    if (!FINISHED.has(a.status) || !((a.lastActivityAt ?? 0) > 0)) continue;
    if (!best || finishedAt(a) > finishedAt(best)) best = a;
  }
  return best;
}

/** When a Ready workspace's agent finished, by the shared rule (issue #98); 0 without one. */
export function readySince(w: Workspace): number {
  const a = finishedAgent(w);
  return a ? finishedAt(a) : 0;
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
  if (!w || !((w.unread ?? 0) > 0) || isSelected(w) || hasRealAsk(w)) return false;
  return FINISHED.has(statusOf(w)) && finishedAgent(w) !== null;
}

// The finished green and word: Ready adds no hue or word of its own.
const READY: StatusStyle = { ...STATUS.ended, halo: "clear" };

// Asking (issue #81): needs_input because the agent stopped on a
// permission or a question, not because its turn ended.
const ASKING: StatusStyle = { label: ASKING_WORD, dot: C.amber, halo: C.amberHalo, text: C.amberText };

/** Why the workspace's agent is asking ("allow git push?"), or null when it is not (shared/needs.ts). */
export const askOf = (w: Workspace | undefined): string | null => askReason(agentOf(w), w);

export function statusInfo(w: Workspace | undefined): StatusStyle {
  if (isReady(w)) return READY;
  // The agent is worked out once, for both the ask and the status.
  const a = agentOf(w);
  if (askReason(a, w)) return ASKING;
  return STATUS[a?.status ?? "none"] ?? STATUS.none;
}

/** A Needs you row's second line: why the agent asks, else its latest message. */
export const needsDetail = (w: Workspace | undefined): string =>
  askOf(w) ?? (oneLine(cardMessage(w), 80) || "Waiting for your reply");

/** A Needs you row's edge: amber while its agent asks, else clay, so each hue keeps one meaning. */
export const needsRowEdge = (w: Workspace | undefined): string => (askOf(w) ? C.amberRowEdge : C.needsRowEdge);

/** The unread count a card's badge shows: none while the Ready pill stands in for it. */
export const badgeCount = (w: Workspace | undefined): number => (isReady(w) ? 0 : (w?.unread ?? 0));

/**
 * The PR as text in a compact card's status line ("· #45 · 1 failing"), else
 * "". Compact cards have no chips, so this is where their PR shows, Ready or
 * not. The full card says nothing about the PR in its status row: the PR
 * line under it carries the verdict (issue #79).
 */
export function compactPrText(pr: Pick<PrSummary, "text"> | undefined): string {
  const t = pr?.text;
  return t ? "· " + t : "";
}

/**
 * A PR written as text (compact and row densities): its health's colour
 * when it has something to say, else the density's own quiet colour.
 */
export function prTextColor(pr: Pick<PrSummary, "health" | "status"> | undefined, quiet: string): string {
  return !pr || pr.health === "quiet" ? quiet : prChipColors(pr.health, pr.status).fg;
}

// --- the card's second line (issue #47) ----------------------------------------------

/** The status and how long it has held ("Working 14m", "Finished 6m").
 * A Ready card counts from when its finished agent finished, and an idle
 * or ended card from when its agent finished, by the rule the agents panel
 * uses (issue #98). Otherwise only the agent's sinceEpoch says when the
 * status began; sinceOf's fallbacks (last activity, the workspace's
 * latestAt) do not, so without it the time is left off. */
export function statusLine(w: Workspace | undefined): string {
  const label = statusInfo(w).label;
  return withAge(label, cardAge(w));
}

function cardAge(w: Workspace | undefined): string {
  if (w && isReady(w)) return ageFrom(readySince(w));
  const a = agentOf(w);
  if (!a) return "";
  return ageFrom(FINISHED.has(a.status) ? finishedAt(a) : a.sinceEpoch);
}

const ageFrom = (since: number | undefined): string => (since ? fmtAge(nowEpoch() - since) : "");

/** "· 3 helpers" while subagent runs are live, else "". */
export function helperText(w: Workspace | undefined): string {
  const n = liveRunCount(w);
  if (!n) return "";
  return "· " + n + (n === 1 ? " helper" : " helpers");
}

/** About two lines of card text at the full card's width. */
export const DETAIL_MAX = 140;

/** The agent's latest message (never a prompt echo), else the description. */
export function cardDetail(w: Workspace | undefined): string {
  // cardMessage is already readable(), so only the description needs it.
  return clip(cardMessage(w) || readable(w?.description), DETAIL_MAX);
}

/** The progress bar's fraction, held to 0 to 1; null when no value is sent. */
export function progressFraction(w: Workspace | undefined): number | null {
  const v = w?.progress?.value;
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  return Math.max(0, Math.min(1, v));
}
