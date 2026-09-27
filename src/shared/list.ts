// List helpers shared by both sidebars.

export type Last<T> = T & { last: boolean };

/** Flags the final row so its hairline rule can be hidden. */
export function markLast<T>(list: T[]): Last<T>[] {
  return list.map((e, i) => ({ ...e, last: i === list.length - 1 }));
}

/** Splits `list` into runs of at most `size`, in order. */
export function chunk<T>(list: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += Math.max(1, size)) out.push(list.slice(i, i + Math.max(1, size)));
  return out;
}
