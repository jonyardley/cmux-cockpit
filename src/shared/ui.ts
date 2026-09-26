// View helpers shared by both sidebars.

/** Shows `view` only while `pred()` is true (a ForEach over zero or one item). */
export function when(key: string, pred: () => boolean, view: () => View): View {
  return ForEach({ items: () => (pred() ? [{ id: key }] : []), key: (x) => x.id }, view);
}

/** Board 1's halo is 3pt of soft colour round the dot: 13pt round a 7pt dot. */
export const haloSize = (dot: number): number => dot + 6;

/** The one status decision behind board 1's halo: working or needs only, everything else "clear". */
export type HaloStatus = "working" | "needs_input";

/** Which status, if any, gets the halo. Each sidebar maps this to its own halo colour. */
export function haloStatus(status: string | undefined): HaloStatus | null {
  return status === "working" || status === "needs_input" ? status : null;
}

/**
 * The halo colour for `status` from the caller's own halo tokens (one entry
 * per HaloStatus), or "clear" for every other status. The one place both
 * sidebars turn the halo decision into an actual colour, so a third haloed
 * status or a changed fallback only needs changing here.
 */
export function haloColor(status: string | undefined, colors: Record<HaloStatus, string>): string {
  const hs = haloStatus(status);
  return hs ? colors[hs] : "clear";
}

/**
 * A dot over board 1's soft halo. The frame is always the halo's size, so
 * dots with and without a halo ("clear") line up down a list.
 */
export function haloDot(dot: View, halo: Reactive<string>, size: number): View {
  const outer = haloSize(size);
  return ZStack({}, [Circle({ size: outer }).fill(halo), dot]).frame({ width: outer, height: outer });
}
