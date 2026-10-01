// The Needs you strip: who waits on Jon, how long, and the cards it stands in for.

import { dismissNeeds, isNeedsDismissed } from "../shared/needs.ts";
import { fmtAge, nowEpoch } from "../shared/time.ts";
import { allWorkspaces } from "./model.ts";
import { bump, drag, tick } from "./state.ts";
import { sinceOf, statusOf } from "./status.ts";

// --- Needs you ---------------------------------------------------------------------------

/**
 * Workspaces waiting on Jon, longest-waiting first. A lane's generated
 * anchor counts too: it is off the cards, but an agent in it can still ask.
 */
const oldestFirst = (a: Workspace, b: Workspace): number => sinceOf(a) - sinceOf(b);

export const needsList = computed(() =>
  allWorkspaces()
    .filter((w) => statusOf(w) === "needs_input")
    .sort(oldestFirst),
);

// The strip lists this many rows, then "+N more" (issue #74), so a long queue
// never pushes the lanes off screen.
const NEEDS_ROWS = 4;

export const needsShown = computed(() => needsList().slice(0, NEEDS_ROWS));

// The header's clock turns clay once the oldest ask has waited this long (issue #153).
export const NEEDS_LATE_SECS = 30 * 60;

/**
 * How long the oldest ask has waited in seconds, timed as its row is; null
 * with no timed ask or no clock. An untimed ask sorts first, so skip it
 * rather than let it blank the clock.
 */
const oldestWait = computed((): number | null => {
  const at = needsList()
    .map(sinceOf)
    .find((t) => t > 0);
  const now = nowEpoch();
  return at && now ? Math.max(0, now - at) : null;
});

/** The header's clock: "12m" for the oldest ask, "" when nothing says. */
export function needsWaitText(): string {
  const secs = oldestWait();
  return secs === null ? "" : fmtAge(secs);
}

/** Whether the oldest ask has waited 30 minutes or more. */
export const needsWaitLate = (): boolean => (oldestWait() ?? 0) >= NEEDS_LATE_SECS;

/** How many waiting workspaces the strip leaves out. */
export const needsMore = (): number => Math.max(0, needsList().length - NEEDS_ROWS);

/**
 * The sessions the Needs you strip lists. Their card leaves its lane or
 * project for a placeholder in the same spot, which the header still
 * counts, and comes back there once answered or dismissed. One past the
 * strip's cap keeps its card. The card being dragged stays a card even if
 * it starts asking, so it never vanishes from under the pointer. Above the
 * lanes and projects, since computed() runs on definition.
 */
export const inStrip = computed((): ReadonlySet<string> => {
  const dragged = drag()?.id;
  return new Set(needsShown().flatMap((w) => (dragged === "w:" + w.id ? [] : [w.id])));
});

// Dismissing from Needs you leaves the card in the placeholder's spot, the
// top of its lane with the other waiting cards, rather than sorting it down
// as idle. It holds there until its status next changes, and a new ask
// releases it too (liveRank). A plain Map: read with tick(), set with
// bump(); a release during render needs no bump, since the status change
// that caused it already redraws.
export const dismissedHold = new Map<string, string>();

/** Dismisses a waiting session from Needs you, holding its card where its placeholder sat. */
export function dismissWaiting(w: Workspace | undefined): void {
  if (!w) return;
  dismissNeeds(w);
  // Only a real dismissal holds: the menu offers it on cards not waiting too.
  if (!isNeedsDismissed(w)) return;
  const live = new Set((data.workspaces() ?? []).map((x) => x.id));
  for (const id of dismissedHold.keys()) if (!live.has(id)) dismissedHold.delete(id);
  dismissedHold.set(w.id, statusOf(w));
  bump();
}

export function heldAtTop(w: Workspace): boolean {
  tick();
  const held = dismissedHold.get(w.id);
  if (held === undefined) return false;
  if (held === statusOf(w)) return true;
  dismissedHold.delete(w.id);
  return false;
}
