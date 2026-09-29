// A short fingerprint of the start of a reply, so a saved move can be tied to
// the reply it came from. The Stop hook (scripts/hooks/report-move.ts) takes
// it from the turn's final reply, the sidebar from the workspace's
// latestMessage, and one function serves both so the two always agree.
// Pure, with no renderer globals, so the hook can import it.

import { readable } from "./text.ts";

/** How much of a message cmux keeps; the hook cuts a reply the same way. */
const MESSAGE_CUT = 240;
/** The longest head kept: letters and digits only. */
export const HEAD_CHARS = 40;

// A markdown link keeps only its words: cmux may strip markdown, and a URL
// would add letters that the stripped message does not have.
const LINK = /\[([^\]]*)\]\([^)]*\)/g;
const NOT_WORD = /[^\p{L}\p{N}]+/gu;

/**
 * The start of `s` as a head: cut to what cmux keeps, readable() as the
 * sidebar reads a message, links reduced to their words, lower-cased, only
 * letters and digits, the first HEAD_CHARS of them. Markdown markers,
 * spaces and punctuation drop out, so the head is the same whether or not
 * cmux keeps the markdown. "" when nothing readable is left.
 */
export function replyHead(s: string | null | undefined): string {
  const words = readable(String(s ?? "").slice(0, MESSAGE_CUT))
    .replace(LINK, "$1")
    .toLowerCase()
    .replace(NOT_WORD, "");
  return Array.from(words).slice(0, HEAD_CHARS).join("");
}

/**
 * Whether `message` is the reply `head` came from: its own head starts with
 * the saved one. Starts with, not equals, since a head cut short by markup
 * in the reply can be longer once cmux strips it. An empty head matches nothing.
 */
export const isReplyOf = (message: string | null | undefined, head: string): boolean =>
  head.length > 0 && replyHead(message).startsWith(head);
