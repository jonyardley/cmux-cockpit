// List helpers shared by both sidebars.

export type Last<T> = T & { last: boolean };

/** Flags the final row so its hairline rule can be hidden. */
export function markLast<T>(list: T[]): Last<T>[] {
  return list.map((e, i) => ({ ...e, last: i === list.length - 1 }));
}
