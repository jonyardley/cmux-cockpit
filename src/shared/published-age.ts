// How long a published page or doc stays listed (#52). Pure, with no
// globals, so both the hook (scripts/hooks/report-published.ts), which
// prunes on each write, and the sidebar reader (published.ts), which
// filters on each read, share one rule.

/** Seven days: older entries drop off. */
export const PUBLISHED_MAX_AGE_S = 7 * 24 * 60 * 60;

/** Whether an entry published at `epoch` is still listed at `now`. */
export const isFresh = (epoch: number, now: number): boolean => now - epoch <= PUBLISHED_MAX_AGE_S;
