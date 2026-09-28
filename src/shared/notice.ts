// A faint line of its own, shared by both sidebars (issue #78's
// unreadable-state line, and the agents panel's quiet notes), so the two
// copies cannot drift apart.

import { when } from "./ui.ts";

/**
 * `text()` in small type in the caller's colour token, up to two lines, set
 * in by `inset` on each side. Shown only while `text()` has something to
 * say, so an empty one costs no gap.
 */
export function faintLine(key: string, text: () => string, color: string, inset: number): View {
  return when(
    key,
    () => !!text(),
    () =>
      Text(text)
        .font(11)
        .color(color)
        .lineLimit(2)
        .paddingHorizontal(inset)
        .frame({ maxWidth: "infinity", alignment: "leading" }),
  );
}
