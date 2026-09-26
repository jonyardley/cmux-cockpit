// A workspace's status, from its most active agent, with "needs you"
// dismissals applied.

import { mostActive } from "../shared/activity.ts";
import { fmtAge, nowEpoch } from "../shared/time.ts";
import { bump, tick } from "./state.ts";
import { C } from "./theme.ts";

export type Status = AgentStatus | "none";

export function agentOf(w: Workspace | undefined): Agent | null {
  return mostActive(w?.agents);
}

// A dismissed "needs you" reads as idle until the agent asks again: the
// dismissal is keyed to the start of that needs_input spell, so a new one
// (a new start) shows. Local only, so a reload forgets it.
const dismissedNeeds = new Map<string, number>(); // wsId -> needs_input start
const needsStart = (a: Agent | null): number => (a && (a.sinceEpoch || a.lastActivityAt)) || 0;

function rawStatusOf(w: Workspace | undefined): Status {
  const a = agentOf(w);
  return a ? a.status : "none";
}

export function isNeedsDismissed(w: Workspace | undefined): boolean {
  tick();
  if (!w || !dismissedNeeds.has(w.id)) return false;
  const a = agentOf(w);
  if (a && a.status === "needs_input" && needsStart(a) === dismissedNeeds.get(w.id)) return true;
  dismissedNeeds.delete(w.id);
  return false;
}

export function statusOf(w: Workspace | undefined): Status {
  const st = rawStatusOf(w);
  return st === "needs_input" && isNeedsDismissed(w) ? "idle" : st;
}

export function dismissNeeds(w: Workspace | undefined): void {
  if (!w || rawStatusOf(w) !== "needs_input") return;
  dismissedNeeds.set(w.id, needsStart(agentOf(w)));
  bump();
}

export function restoreNeeds(w: Workspace | undefined): void {
  if (w && dismissedNeeds.delete(w.id)) bump();
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

const STATUS: Record<Status, StatusStyle> = {
  working: { label: "Working", dot: C.blue, halo: C.blueHalo, text: "#2F5690" },
  needs_input: { label: "Needs you", dot: C.clay, halo: C.clayHalo, text: C.clayText },
  idle: { label: "Idle", dot: null, halo: "clear", text: "#6B6A64" },
  ended: { label: "Done", dot: C.green, halo: "clear", text: "#5E7A40" },
  none: { label: "No agent", dot: null, halo: "clear", text: "#8A8880" },
};

export const statusInfo = (w: Workspace | undefined): StatusStyle => STATUS[statusOf(w)] ?? STATUS.none;
