// Clock and duration formatting shared by both sidebars.

/** The app clock in epoch seconds; 0 before the first tick. */
export function nowEpoch(): number {
  return data.clock()?.epoch || 0;
}

/** Coarse age, "12m" since `at`, for both sidebars; "" without a timestamp
 * or clock. A timestamp ahead of the clock reads as "<1m", never blank. */
export function ageSince(at: number | undefined): string {
  const now = nowEpoch();
  return at && now ? fmtAge(Math.max(0, now - at)) : "";
}

/** Coarse age for cards: "<1m", "12m", "3h", "2d"; "" for a bad input. */
export function fmtAge(secs: number): string {
  if (!(secs >= 0)) return "";
  if (secs < 60) return "<1m";
  if (secs < 3600) return Math.floor(secs / 60) + "m";
  if (secs < 86400) return Math.floor(secs / 3600) + "h";
  return Math.floor(secs / 86400) + "d";
}

/** Finer elapsed time for agents: "45s", "12m", "3h 5m", "2d". */
export function fmtElapsed(secs: number): string {
  const s = Math.max(0, Math.floor(secs));
  if (s < 60) return s + "s";
  const m = Math.floor(s / 60);
  if (m < 60) return m + "m";
  const h = Math.floor(m / 60);
  if (h < 24) return h + "h " + (m % 60) + "m";
  return Math.floor(h / 24) + "d";
}

/**
 * When a finished (idle or ended) agent finished, in epoch seconds: the start
 * of its current status, which is its move to idle or ended, else its last
 * activity; 0 when neither is known. One rule for both sidebars (issue #98),
 * so the agents panel's Idle rows and the cockpit's Ready card give the same
 * agent the same age. The last activity is only the fallback: it says when
 * the agent last did something, not when it finished.
 */
export function finishedAt(a: Agent): number {
  return a.sinceEpoch || a.lastActivityAt || 0;
}
