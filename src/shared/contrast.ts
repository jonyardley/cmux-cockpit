// A project glyph's colour needs to hold against its own background (issue
// #2): a light project colour such as #B0AEA5 reads a white glyph as barely
// there. Picks whichever of white or the caller's dark glyph colour (each
// sidebar's own `text` token, passed in rather than copied here) gives the
// better WCAG contrast ratio against the background, by relative luminance.
// A background that is not a plain hex colour (config/projects.json is
// hand-edited and gitignored, so a stray named colour or odd digit count can
// reach here) falls back to white, the colour every glyph had before this.

const LIGHT_GLYPH = "#FFFFFF";
const HEX_LENGTHS = new Set([3, 4, 6, 8]);

function srgbChannel(byte: number): number {
  const c = byte / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/**
 * WCAG relative luminance of a hex colour (3, 4, 6 or 8 hex digits; a 4th or
 * 8th alpha pair is ignored), or null when `hex` is not a hex colour at all.
 */
function relativeLuminance(hex: string): number | null {
  const digits = hex.replace(/^#/, "");
  if (!HEX_LENGTHS.has(digits.length) || !/^[0-9a-fA-F]+$/.test(digits)) return null;
  const full = digits.length <= 4 ? digits.slice(0, 3).replace(/./g, (c) => c + c) : digits.slice(0, 6);
  const r = Number.parseInt(full.slice(0, 2), 16);
  const g = Number.parseInt(full.slice(2, 4), 16);
  const b = Number.parseInt(full.slice(4, 6), 16);
  return 0.2126 * srgbChannel(r) + 0.7152 * srgbChannel(g) + 0.0722 * srgbChannel(b);
}

/** WCAG contrast ratio between two relative luminances. */
function contrastRatio(a: number, b: number): number {
  const lighter = Math.max(a, b);
  const darker = Math.min(a, b);
  return (lighter + 0.05) / (darker + 0.05);
}

// LIGHT_GLYPH is a fixed, valid 6-digit hex literal, so this can never be null.
const LIGHT_LUMINANCE = relativeLuminance(LIGHT_GLYPH) as number;

/**
 * The glyph colour, white or `dark` (the caller's own text token), with the
 * higher contrast against `bg`. Falls back to white when `bg` cannot be read
 * as a hex colour.
 */
export function glyphColor(bg: string, dark: string): string {
  const bgLuminance = relativeLuminance(bg);
  if (bgLuminance === null) return LIGHT_GLYPH;
  const darkLuminance = relativeLuminance(dark) ?? 0;
  const lightContrast = contrastRatio(bgLuminance, LIGHT_LUMINANCE);
  const darkContrast = contrastRatio(bgLuminance, darkLuminance);
  return darkContrast > lightContrast ? dark : LIGHT_GLYPH;
}
