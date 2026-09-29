// Hover faces for the tap targets. cmux's hoverBackground replaces a node's
// background under the pointer rather than washing over it, so a hover face
// on a chip or card has to be a whole colour of its own: its resting colour
// taken a step toward ink, and a faint face a step more opaque as well.

import { P } from "./palette.ts";

const channels = (rgb: string): number[] => [0, 2, 4].map((i) => Number.parseInt(rgb.slice(i, i + 2), 16));

// The palette's ink as channels. P.text is a fixed 6-digit hex.
const INK = channels(P.text.slice(1));

/**
 * `hex` mixed `amount` (0 to 1) of the way toward ink, keeping any alpha
 * pair. A colour that is not a 6- or 8-digit hex comes back unchanged, so a
 * stray token never hides a face.
 */
export function shade(hex: string, amount: number): string {
  const m = /^#([0-9a-fA-F]{6})([0-9a-fA-F]{2})?$/.exec(hex);
  if (!m?.[1]) return hex;
  const mixed = channels(m[1]).map((c, i) => {
    const ink = INK[i] ?? 0;
    return Math.round(c + (ink - c) * amount)
      .toString(16)
      .padStart(2, "0");
  });
  return "#" + mixed.join("").toUpperCase() + (m[2] ?? "");
}

// How much more opaque a faint face gets under the pointer: 0x14 of 0xFF, so
// a 1A face reads 2E.
const ALPHA_STEP = 0x14;

/**
 * A hover face: `hex` shaded `amount` toward ink, and when it carries an
 * alpha pair (a faint face of a hue) that pair raised by a step, capped at
 * FF. Shading alone barely shows on a face that is mostly the card behind
 * it, since the hue steps but the card still shows through as much.
 */
export function hoverFace(hex: string, amount: number): string {
  const shaded = shade(hex, amount);
  const m = /^(#[0-9A-F]{6})([0-9a-fA-F]{2})$/.exec(shaded);
  if (!m?.[1] || !m[2]) return shaded;
  const alpha = Math.min(0xff, Number.parseInt(m[2], 16) + ALPHA_STEP);
  return m[1] + alpha.toString(16).padStart(2, "0").toUpperCase();
}
