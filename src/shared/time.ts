// Clock and duration formatting shared by both sidebars.

/** The app clock in epoch seconds; 0 before the first tick. */
export function nowEpoch(): number {
  return data.clock()?.epoch || 0;
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
