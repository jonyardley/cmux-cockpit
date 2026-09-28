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

// Turns the harness writes into a session, which cmux reports as the latest
// prompt and message just like one Jon typed (issue #103). cmux cuts both to
// 240 characters, so a turn that opens with a tag is the harness's when the
// block is left open (a hand-back cut short) or nothing readable is left (a
// finished-subagent notice, local command output). A closed block ahead of
// real words is only context, so those words still count.
const OPENING_TAG = /^\s*<([A-Za-z][\w:-]*)/;
const HARNESS_FRAMES = ["[Subagent hand-back]", "[Artifact comment sent to Claude]", "[Request interrupted by user"];

/** Whether a raw prompt or message is a harness turn rather than Jon's or
 * the agent's words. `t` is its readable() text, when the caller has it. */
export function isHarnessTurn(raw: string | undefined, t: string = readable(raw)): boolean {
  const s = raw ?? "";
  const tag = OPENING_TAG.exec(s)?.[1];
  if (tag && (!t || !s.includes("</" + tag))) return true;
  return HARNESS_FRAMES.some((f) => t.startsWith(f));
}

// The last prompt Jon typed in each workspace, so a harness turn (a
// subagent's hand-back or finished notice, local command output, issue #103)
// keeps it on screen. Written during render with no bump(): what shows is
// the value just read, and a sidebar reload only forgets it, so the line
// hides until he next types.
const lastPrompt = new Map<string, string>();

/** The last prompt Jon typed, readable, kept through a harness turn; "" when there is none. */
export function promptText(w: Workspace | undefined): string {
  if (!w) return "";
  const t = readable(w.latestPrompt);
  if (isHarnessTurn(w.latestPrompt, t)) return lastPrompt.get(w.id) ?? "";
  if (t) lastPrompt.set(w.id, t);
  return t;
}

/** A card's message line: latestMessage, unless it only echoes the prompt. */
export function cardMessage(w: Workspace | undefined): string {
  const msg = readable(w?.latestMessage);
  if (isHarnessTurn(w?.latestMessage, msg)) return "";
  return msg && msg === readable(w?.latestPrompt) ? "" : msg;
}
