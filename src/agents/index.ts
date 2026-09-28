// agents: Jon's right panel. Each fact lives in one place: the cockpit on
// the left is the roster of every workspace, so this panel is only about the
// selected workspace, plus what belongs to no single card. Sections:
//   This workspace - the selected workspace in detail (views/current.ts),
//                    headed with its project; its name is the highlighted
//                    card on the left. What that card has no room for: its
//                    agent's latest message, running helpers, ports, the PR
//                    and its checks, and a faint branch footer. When its
//                    agent needs you, the card carries the question, Answer
//                    (select + focus surface) and Dismiss (local to this
//                    panel, src/shared/needs.ts). No Allow/Deny: that needs
//                    the real diff/tool-call payload, which this data
//                    context does not carry, so it is not faked. Other
//                    workspaces that need you do not appear in this panel at
//                    all, by design: the cockpit's Needs you strip is their
//                    one home.
//   Pull requests  - every PR across workspaces, tap opens the url. A faint
//                    line under the heading says when the saved PR data is
//                    old or gh is down, and those chips dim (#78).
//   Made here      - pages and docs agents published (#52): this workspace's
//                    first, then the latest few from others; tap opens it.
// Counts are the real totals, and a capped list ends in "+N more" (#80).
// Pull requests shows its heading and count when empty; Made here, and the
// card's Helpers, fold into one faint line at the bottom instead. When
// config/state.json could not be read at build, a line at the top says so
// rather than the panel just looking empty (#78).
//
//   cmux right-sidebar set custom agents

import { stateNotice } from "../shared/freshness.ts";
import { faintLine } from "../shared/notice.ts";
import { when } from "../shared/ui.ts";
import {
  current,
  currentHeading,
  emptyNote,
  madeCount,
  madeFoot,
  madeHere,
  prCount,
  prFoot,
  prNote,
  prs,
  toggleExpanded,
} from "./model.ts";
import { T } from "./theme.ts";
import { currentPanel } from "./views/current.ts";
import { panel, sectionHeader } from "./views/parts.ts";
import { footRow, madeRow, prRow } from "./views/rows.ts";

function currentSection(): View {
  return when(
    "current",
    () => !!current(),
    () => VStack({ spacing: 8, alignment: "leading" }, [sectionHeader(currentHeading), currentPanel()]),
  );
}

// A faint note in the panel's quiet colour, lined up with the headings.
const faintNote = (key: string, text: () => string, color: string = T.tertiary): View => faintLine(key, text, color, 4);

interface ListSection<T extends { key: string; last: boolean }> {
  label: string;
  key: string;
  count: () => number;
  rows: () => T[];
  row: (e: () => T) => View;
  /** The closing "+N more" or "Show less" line, "" for none; none by default. */
  foot?: () => string;
  /** Opens or folds the card when its closing line is tapped. */
  toggle?: () => void;
  /** A faint line under the heading; none by default. */
  note?: () => string;
}

// A heading with its count, over a card of rows only while there are some,
// the card ending in "+N more" when the list was cut, "Show less" once open.
function listSection<T extends { key: string; last: boolean }>(s: ListSection<T>): View {
  const foot = s.foot ?? (() => "");
  const toggle = s.toggle ?? (() => {});
  return VStack({ spacing: 8, alignment: "leading" }, [
    sectionHeader(s.label, () => String(s.count())),
    ...(s.note ? [faintNote(s.key + "-note", s.note)] : []),
    when(
      s.key,
      () => s.rows().length > 0,
      () =>
        panel([
          ForEach({ items: s.rows, key: (e) => e.key }, (e) => s.row(e)),
          when(
            s.key + "-more",
            () => foot() !== "",
            () => footRow(foot, toggle),
          ),
        ]),
    ),
  ]);
}

sidebar(
  () =>
    VStack({ spacing: 18, alignment: "leading" }, [
      faintNote("state-notice", stateNotice, T.clayText),
      currentSection(),
      listSection({
        label: "PULL REQUESTS",
        key: "prs",
        count: prCount,
        rows: prs,
        row: prRow,
        foot: prFoot,
        toggle: () => toggleExpanded("prs"),
        note: prNote,
      }),
      when(
        "made-section",
        () => madeCount() > 0,
        () =>
          listSection({
            label: "MADE HERE",
            key: "made",
            count: madeCount,
            rows: madeHere,
            row: madeRow,
            foot: madeFoot,
            toggle: () => toggleExpanded("made"),
          }),
      ),
      faintNote("empty-note", emptyNote),
      Spacer(),
    ])
      .paddingHorizontal(14)
      .paddingVertical(14),
  { surface: "glass" },
);
