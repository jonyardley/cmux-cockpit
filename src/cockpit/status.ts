// A workspace's status, from its most active agent, with idle nudges and
// "needs you" dismissals applied (src/shared/needs.ts).

import { mostActive } from "../shared/activity.ts";
import { agentsOf, hasRealAsk } from "../shared/needs.ts";
import { prChipColors } from "../shared/pr-colors.ts";
import { type PrSummary, prSummary } from "../shared/prs.ts";
import { liveRunCount } from "../shared/subagents.ts";
import { cardMessage, clip, readable } from "../shared/text.ts";
import { fmtAge, nowEpoch } from "../shared/time.ts";
import { type HaloStatus, haloColor } from "../shared/ui.ts";
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

const STATUS: Record<Status, StatusStyle> = {
  working: { label: "Working", dot: C.blue, halo: haloColor("working", HALO_COLOR), text: "#2F5690" },
  needs_input: { label: "Needs you", dot: C.clay, halo: haloColor("needs_input", HALO_COLOR), text: C.clayText },
  idle: { label: "Idle", dot: null, halo: haloColor("idle", HALO_COLOR), text: "#6B6A64" },
  ended: { label: "Done", dot: C.green, halo: haloColor("ended", HALO_COLOR), text: C.greenText },
  none: { label: "No agent", dot: null, halo: haloColor("none", HALO_COLOR), text: "#8A8880" },
};

// Ready: finished and not yet looked at (issue #53).

const FINISHED: ReadonlySet<Status> = new Set<Status>(["idle", "ended"]);

/**
 * The agent finished while Jon was elsewhere: its status settled on idle or
 * ended (a Claude idle nudge counts, since agentsOf reads it as idle), it had
 * worked (cmux recorded activity), and the workspace holds output he has not
 * read. Opening the workspace clears it: cmux marks it read, and a selected
 * workspace is being looked at anyway. A real ask is never Ready, even one
 * dismissed from Needs you: the agent stopped to ask, it did not finish.
 */
export function isReady(w: Workspace | undefined): boolean {
  if (!w || !((w.unread ?? 0) > 0) || w.selected || hasRealAsk(w)) return false;
  const a = agentOf(w);
  return !!a && FINISHED.has(a.status) && (a.lastActivityAt ?? 0) > 0;
}

// The done green: Ready adds no hue of its own.
const READY: StatusStyle = { label: "Finished", dot: C.green, halo: "clear", text: C.greenText };

export const statusInfo = (w: Workspace | undefined): StatusStyle =>
  isReady(w) ? READY : (STATUS[statusOf(w)] ?? STATUS.none);

/** The unread count a card's badge shows: none while the Ready pill stands in for it. */
export const badgeCount = (w: Workspace | undefined): number => (isReady(w) ? 0 : (w?.unread ?? 0));

// What a Ready card's second line says about the PR, after "Finished 6m ago".
function prWords(pr: PrSummary): string {
  const tag = "PR " + pr.tag;
  if (pr.status && pr.status !== "open") return tag + " " + pr.status;
  if (pr.health === "ready") return tag + " is green";
  if (pr.health === "failing") return tag + " is failing";
  if (pr.health === "running") return tag + " checks running";
  return tag + (pr.draft ? " is a draft" : " is open");
}

/** "· PR #45 is green" on a Ready card with a PR, else "". */
export function readyPrText(w: Workspace | undefined): string {
  const pr = isReady(w) ? prSummary(w) : undefined;
  return pr ? "· " + prWords(pr) : "";
}

/**
 * A PR written as text (compact and row densities): its health's colour
 * when it has something to say, else the density's own quiet colour.
 */
export function prTextColor(pr: PrSummary | undefined, quiet: string): string {
  return !pr || pr.health === "quiet" ? quiet : prChipColors(pr.health, pr.status).fg;
}

// --- the card's second line (issue #47) ----------------------------------------------

/** The status and how long it has held ("Working 14m", "Finished 6m ago").
 * Only the agent's sinceEpoch says when the status began; sinceOf's
 * fallbacks (last activity, the workspace's latestAt) do not, so without it
 * the time is left off. */
export function statusLine(w: Workspace | undefined): string {
  const label = statusInfo(w).label;
  const since = agentOf(w)?.sinceEpoch;
  const age = since ? fmtAge(nowEpoch() - since) : "";
  if (!age) return label;
  // A Ready card says when it finished: "Finished 6m ago".
  return isReady(w) ? label + " " + age + " ago" : label + " " + age;
}

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
