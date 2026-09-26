// View helpers shared by both sidebars.

/** Shows `view` only while `pred()` is true (a ForEach over zero or one item). */
export function when(key: string, pred: () => boolean, view: () => View): View {
  return ForEach({ items: () => (pred() ? [{ id: key }] : []), key: (x) => x.id }, view);
}

/** Board 1's halo is 3pt of soft colour round the dot: 13pt round a 7pt dot. */
export const haloSize = (dot: number): number => dot + 6;

/**
 * A dot over board 1's soft halo. The frame is always the halo's size, so
 * dots with and without a halo ("clear") line up down a list.
 */
export function haloDot(dot: View, halo: Reactive<string>, size: number): View {
  const outer = haloSize(size);
  return ZStack({}, [Circle({ size: outer }).fill(halo), dot]).frame({ width: outer, height: outer });
}
