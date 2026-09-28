// Version numbers for the preflight and the doctor: the Node and cmux
// floors the quickstart names, and how to read and compare them.

export type Version = readonly [number, number, number];

export const NODE_MIN: Version = [24, 2, 0];
/** What the sidebars are tested on. */
export const CMUX_MIN: Version = [0, 64, 25];
/** Highlighting a lane while a card is dragged over it needs this. */
export const CMUX_DRAG: Version = [0, 65, 0];

/** The first x.y or x.y.z in `text` ("v24.2.0", "cmux 0.64.25 (106)"), or null. */
export function parseVersion(text: string): Version | null {
  const m = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(text);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)];
}

/** True when `v` is `min` or later. */
export function atLeast(v: Version, min: Version): boolean {
  for (let i = 0; i < 3; i++) {
    const a = v[i] ?? 0;
    const b = min[i] ?? 0;
    if (a !== b) return a > b;
  }
  return true;
}

export const show = (v: Version): string => v.join(".");
