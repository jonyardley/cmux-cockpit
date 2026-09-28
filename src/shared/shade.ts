// Hover faces for the tap targets. cmux's hoverBackground replaces a node's
// background under the pointer rather than washing over it, so a hover face
// on a chip or card has to be a whole colour of its own: its resting colour
// taken a step toward ink.

const INK = [20, 20, 19] as const;

/**
 * `hex` mixed `amount` (0 to 1) of the way toward ink, keeping any alpha
 * pair. A colour that is not a 6- or 8-digit hex comes back unchanged, so a
 * stray token never hides a face.
 */
export function shade(hex: string, amount: number): string {
  const m = /^#([0-9a-fA-F]{6})([0-9a-fA-F]{2})?$/.exec(hex);
  if (!m?.[1]) return hex;
  const rgb = m[1];
  const mixed = INK.map((ink, i) => {
    const c = Number.parseInt(rgb.slice(i * 2, i * 2 + 2), 16);
    return Math.round(c + (ink - c) * amount)
      .toString(16)
      .padStart(2, "0");
  });
  return "#" + mixed.join("").toUpperCase() + (m[2] ?? "");
}
