// The saved half of the local state loop (docs/state-loop.md): __STATE__ is
// baked in by scripts/build.ts from config/state.json, and persistSet sends
// one change back out to the URL handler that writes it. Both sidebars call
// this, so it lives in shared rather than being duplicated.

// State's shape is scripts/state-config.ts's contract; imported as a type
// only, so esbuild erases it and a sidebar never bundles the script itself.
import type { SavedProject, State } from "../../scripts/state-config.ts";

declare const __STATE__: State;
// Baked in beside __STATE__ (issue #78). Read through typeof, so a bundle or
// test that never defines it reads false rather than throwing.
declare const __STATE_UNREADABLE__: boolean | undefined;
// This install's config/url-token, baked in by build.ts so the handler
// can tell our links from a web page's. Read the same guarded way, so a
// test that never defines it sends no token param.
declare const __URL_TOKEN__: string | undefined;
const URL_TOKEN: string = typeof __URL_TOKEN__ === "string" ? __URL_TOKEN__ : "";

/** Whatever config/state.json held at the last build; empty if there was none. */
export const SAVED_STATE: State = __STATE__;

/**
 * True when config/state.json was there at the last build but could not be
 * read, so SAVED_STATE is empty for that reason rather than because nothing
 * was saved.
 */
export const STATE_UNREADABLE: boolean = typeof __STATE_UNREADABLE__ === "boolean" && __STATE_UNREADABLE__;

/**
 * Tells the (separately installed) URL handler to set or delete one entry.
 * `key` is `<map>.<id>`, matching scripts/state-config.ts's applySet; a
 * null value asks for a delete instead of a set. The install's token goes
 * last, so the handler accepts the link. With no handler installed,
 * openURL to the unclaimed cmux-cockpit:// scheme does nothing.
 */
export function persistSet(key: string, value: string | Record<string, number> | SavedProject | null): void {
  const q = value === null ? "" : `&value=${encodeURIComponent(JSON.stringify(value))}`;
  const t = URL_TOKEN === "" ? "" : `&token=${encodeURIComponent(URL_TOKEN)}`;
  openURL(`cmux-cockpit://set?key=${encodeURIComponent(key)}${q}${t}`);
}
