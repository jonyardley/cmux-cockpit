// Text clean-up shared by both sidebars.

// Claude's terminal titles lead with a spinner glyph (✳, ⏺, braille dots).
export function cleanTitle(s: string | null | undefined): string {
  return String(s || "")
    .replace(/^[^\p{L}\p{N}~/#([]+/u, "")
    .trim();
}

// Agent messages can carry raw markup (e.g. <task-notification> blocks).
// Drop whole tag blocks first, then any lone tags left over.
export function stripTags(s: string | null | undefined): string {
  let t = String(s || "");
  let prev: string;
  do {
    prev = t;
    t = t.replace(/<([A-Za-z][\w:-]*)\b[^>]*>[\s\S]*?<\/\1\s*>/g, " ");
  } while (t !== prev);
  return t.replace(/<\/?[A-Za-z][^>]*>/g, " ").replace(/<[^>]*$/, " ");
}

// A message that is only markup or only file paths (a task output file under
// /private/tmp, say) says nothing to a person: treat it as unreadable so the
// caller falls back to its default copy.
export function readable(s: string | null | undefined): string {
  const t = stripTags(s)
    .replace(/\[(?:Image|Pasted text)[^\]]*\]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const words = t
    .replace(/(?:~|\.{0,2})\/[^\s]*/g, " ")
    .replace(/[^A-Za-z]+/g, " ")
    .trim();
  return /[A-Za-z]{2,}/.test(words) ? t : "";
}

/** `t` cut to `max` characters with an ellipsis. */
export function clip(t: string, max: number): string {
  return t.length > max ? t.slice(0, max - 1) + "…" : t;
}

/** readable(), cut to `max` characters with an ellipsis. */
export function oneLine(s: string | null | undefined, max: number): string {
  return clip(readable(s), max);
}

// The renderer has no letter-spacing modifier, so tracking goes in the string:
// a hair space (U+200A) is 0.075em in the system font, near the design's
// 0.08em. Word gaps stay plain spaces. Pair with lineLimit(1), since each
// hair space is a line-break opportunity.
export function tracked(s: string): string {
  let out = "";
  let prev = "";
  for (const ch of s) {
    if (prev && prev !== " " && ch !== " ") out += " ";
    out += ch;
    prev = ch;
  }
  return out;
}

/** A card's message line: latestMessage, unless it only echoes the prompt. */
export function cardMessage(w: Workspace | undefined): string {
  const msg = readable(w?.latestMessage);
  return msg && msg === readable(w?.latestPrompt) ? "" : msg;
}
