// A workspace's status, from its most active agent, with idle nudges and
// "needs you" dismissals applied (src/shared/needs.ts).

import { mostActive } from "../shared/activity.ts";
import { agentsOf } from "../shared/needs.ts";
import { fmtAge, nowEpoch } from "../shared/time.ts";
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

const STATUS: Record<Status, StatusStyle> = {
  working: { label: "Working", dot: C.blue, halo: C.blueHalo, text: "#2F5690" },
  needs_input: { label: "Needs you", dot: C.clay, halo: C.clayHalo, text: C.clayText },
  idle: { label: "Idle", dot: null, halo: "clear", text: "#6B6A64" },
  ended: { label: "Done", dot: C.green, halo: "clear", text: "#5E7A40" },
  none: { label: "No agent", dot: null, halo: "clear", text: "#8A8880" },
};

export const statusInfo = (w: Workspace | undefined): StatusStyle => STATUS[statusOf(w)] ?? STATUS.none;
