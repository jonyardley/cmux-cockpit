// A section of the agents panel: a heading with its count over a card of
// rows. Both tabs build their lists from it, so a Details card looks like a
// Now one.

import { faintLine } from "../../shared/notice.ts";
import { motionList, when } from "../../shared/ui.ts";
import { T } from "../theme.ts";
import { panel, sectionHeader } from "./parts.ts";
import { footRow } from "./rows.ts";

/** A faint note in the panel's quiet colour, lined up with the headings. */
export const faintNote = (key: string, text: () => string, color: string = T.tertiary): View =>
  faintLine(key, text, color, 4);

export interface ListSection<T extends { key: string; last: boolean }> {
  label: string;
  key: string;
  count: () => number;
  rows: () => T[];
  row: (e: () => T) => View;
  /** The closing "+N more" or "Show less" line ("" for none) and what a tap
   * on it does; no line by default. One field, so a line always has its tap. */
  foot?: { text: () => string; toggle: () => void };
  /** A faint line under the heading; none by default. */
  note?: () => string;
}

/** A heading with its count, over a card of rows only while there are some,
 * the card ending in "+N more" when the list was cut, "Show less" once open. */
export function listSection<T extends { key: string; last: boolean }>(s: ListSection<T>): View {
  const foot = s.foot;
  return VStack({ spacing: 8, alignment: "leading" }, [
    sectionHeader(s.label, () => String(s.count())),
    ...(s.note ? [faintNote(s.key + "-note", s.note)] : []),
    when(
      s.key,
      () => s.rows().length > 0,
      () =>
        panel([
          motionList({ items: s.rows, key: (e) => e.key, spacing: 0 }, (e) => s.row(e)),
          ...(foot
            ? [
                when(
                  s.key + "-more",
                  () => foot.text() !== "",
                  () => footRow(foot.text, foot.toggle),
                ),
              ]
            : []),
        ]),
    ),
  ]);
}
