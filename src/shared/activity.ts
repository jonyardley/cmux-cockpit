// Agent ranking shared by both sidebars: needs_input beats working beats
// idle beats ended, then the most recent activity wins.

export const ACTIVITY: Readonly<Record<AgentStatus, number>> = { needs_input: 3, working: 2, idle: 1, ended: 0 };

const rank = (a: Agent): number => (a.status ? (ACTIVITY[a.status] ?? -1) : -1);

/** Sort comparator: most active agent first. */
export function byActivity(x: Agent, y: Agent): number {
  return rank(y) - rank(x) || (y.lastActivityAt || 0) - (x.lastActivityAt || 0);
}

// A workspace's status comes from its most active agent: agents[0] alone can
// be a stale idle session sitting next to a working one. Ties keep the first.
export function mostActive(agents: readonly (Agent | null | undefined)[] | null | undefined): Agent | null {
  let best: Agent | null = null;
  for (const a of agents || []) {
    if (!a) continue;
    if (!best) {
      best = a;
      continue;
    }
    const d = rank(a) - rank(best);
    if (d > 0 || (d === 0 && (a.lastActivityAt || 0) > (best.lastActivityAt || 0))) best = a;
  }
  return best;
}

/** When the agent's current status began, else its last activity; 0 when neither is known. */
export const sinceOrActivity = (a: Agent): number => a.sinceEpoch ?? a.lastActivityAt ?? 0;
