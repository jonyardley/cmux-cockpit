// The saved half of the local state loop (docs/state-loop.md): __STATE__ is
// baked in by scripts/build.ts from config/state.json, and persistSet sends
// one change back out to the URL handler that writes it. Both sidebars call
// this, so it lives in shared rather than being duplicated.

// State's shape is scripts/state-config.ts's contract; imported as a type
// only, so esbuild erases it and a sidebar never bundles the script itself.
import type { State } from "../../scripts/state-config.ts";

declare const __STATE__: State;

/** Whatever config/state.json held at the last build; empty if there was none. */
export const SAVED_STATE: State = __STATE__;

/**
 * Tells the (separately installed) URL handler to set or delete one entry.
 * `key` is `<map>.<wsId>`, matching scripts/state-config.ts's applySet; a
 * null value asks for a delete instead of a set. With no handler installed,
 * openURL to the unclaimed cmux-cockpit:// scheme does nothing.
 */
export function persistSet(key: string, value: string | Record<string, number> | null): void {
  const q = value === null ? "" : `&value=${encodeURIComponent(JSON.stringify(value))}`;
  openURL(`cmux-cockpit://set?key=${encodeURIComponent(key)}${q}`);
}
