// A project glyph's colour needs to hold against its own background (issue
// #2): a light project colour such as #B0AEA5 reads a white glyph as barely
// there. Picks whichever of white or near-black gives the better WCAG
// contrast ratio against the given background, by relative luminance.

const LIGHT_GLYPH = "#FFFFFF";
const DARK_GLYPH = "#141413"; // matches both sidebars' `text` token

function srgbChannel(byte: number): number {
  const c = byte / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** WCAG relative luminance of a hex colour (3, 6 or 8 hex digits; alpha ignored). */
function relativeLuminance(hex: string): number {
  const digits = hex.replace("#", "");
  const full = digits.length === 3 ? digits.replace(/./g, (c) => c + c) : digits;
  const r = Number.parseInt(full.slice(0, 2), 16) || 0;
  const g = Number.parseInt(full.slice(2, 4), 16) || 0;
  const b = Number.parseInt(full.slice(4, 6), 16) || 0;
  return 0.2126 * srgbChannel(r) + 0.7152 * srgbChannel(g) + 0.0722 * srgbChannel(b);
}

/** WCAG contrast ratio between two relative luminances. */
function contrastRatio(a: number, b: number): number {
  const lighter = Math.max(a, b);
  const darker = Math.min(a, b);
  return (lighter + 0.05) / (darker + 0.05);
}

/** The glyph colour (white or near-black) with the higher contrast against `bg`. */
export function glyphColor(bg: string): string {
  const bgLuminance = relativeLuminance(bg);
  const lightContrast = contrastRatio(bgLuminance, relativeLuminance(LIGHT_GLYPH));
  const darkContrast = contrastRatio(bgLuminance, relativeLuminance(DARK_GLYPH));
  return darkContrast > lightContrast ? DARK_GLYPH : LIGHT_GLYPH;
}
