// The agents panel's capped lists: how many rows a cap leaves out, which
// cards are open past their cap, and the closing "+N more" line. Which are
// open is panel state, set by toggleExpanded.

import { type Last, markLast } from "../shared/list.ts";

// Capped lists

/** How many of `total` rows a cap of `max` leaves out; 0 when none are. */
export const moreThan = (total: number, max: number): number => Math.max(0, total - max);

/** markLast, except that while the list overflows its cap (`more` > 0) no
 * row is last: a closing "+N more" or, once open, "Show less" line follows,
 * so the final row keeps its rule above it. */
export function markLastBefore<T>(rows: T[], more: number): Last<T>[] {
  return more > 0 ? rows.map((e) => ({ ...e, last: false })) : markLast(rows);
}

/** The cards whose "+N more" line can be tapped open (#109). */
export type ListKey = "prs" | "made";

// Which cards are open past their cap, each with what it was opened for:
// Made here with the selected workspace, since its rows depend on it, so
// selecting another workspace shows that one folded. Not saved: a reload
// folds them.
const [openLists, setOpenLists] = signal<ReadonlyMap<ListKey, string>>(new Map());

const selectedId = (): string => (data.workspaces() ?? []).find((w) => w.selected)?.id ?? "";
const openFor = (k: ListKey): string => (k === "made" ? selectedId() : "");

export const isExpanded = (k: ListKey): boolean => {
  const at = openLists().get(k);
  return at !== undefined && at === openFor(k);
};

/** Opens a card past its cap, or folds it back. */
export function toggleExpanded(k: ListKey): void {
  const next = new Map(openLists());
  if (isExpanded(k)) next.delete(k);
  else next.set(k, openFor(k));
  setOpenLists(next);
}

/** The line a capped card ends in: "+N more" while cut, "Show less" while
 * open past its cap, "" when the list fits. `over` is how many rows the cap
 * leaves out when the card is folded. */
export function footText(over: number, expanded: boolean): string {
  if (over <= 0) return "";
  return expanded ? "Show less" : "+" + over + " more";
}
