// Hover faces for the tap targets. cmux's hoverBackground replaces a node's
// background under the pointer rather than washing over it, so a hover face
// on a chip or card has to be a whole colour of its own: its resting colour
// taken a step toward ink.

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
