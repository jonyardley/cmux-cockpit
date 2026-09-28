// agents: Jon's right panel. Sections over live workspace/agent data:
//   This workspace - the selected workspace in detail (views/current.ts):
//                    what the left card has no room for, its agent's latest
//                    message, subagent runs, branch and uncommitted changes,
//                    ports, the PR and its checks. When its agent needs you,
//                    the card carries the question, Answer (select + focus
//                    surface) and Dismiss (local to this panel,
//                    src/shared/needs.ts). No Allow/Deny: that needs the real
//                    diff/tool-call payload, which this data context does not
//                    carry, so it is not faked. Other workspaces that need you
//                    do not appear in this panel at all, by design: the
//                    cockpit's Needs you strip is their one home.
//   Working        - working agents in other workspaces, longest-running first.
//   Idle           - idle agents in other workspaces, most recent first,
//                    collapsed behind "N more idle".
//   Pull requests  - every PR across workspaces, tap opens the url. A faint
//                    line under the heading says when the saved PR data is
//                    old or gh is down, and those chips dim (#78).
//   Made here      - pages and docs agents published (#52): this workspace's
//                    first, then the latest few from others; tap opens it.
// Counts are the real totals, and a capped list ends in "+N more" (#80).
// Working, Idle and Pull requests show their heading and count when empty;
// Made here, and the card's Subagents, fold into one faint line at the
// bottom instead. When config/state.json could not be read at build, a line
// at the top says so rather than the panel just looking empty (#78).
//
//   cmux right-sidebar set custom agents

import { stateNotice } from "../shared/freshness.ts";
import { when } from "../shared/ui.ts";
import {
  current,
  emptyNote,
  idleRows,
  madeCount,
  madeHere,
  madeMore,
  prCount,
  prMore,
  prNote,
  prs,
  roster,
  workingRows,
} from "./model.ts";
import { T } from "./theme.ts";
import { currentPanel } from "./views/current.ts";
import { panel, sectionHeader } from "./views/parts.ts";
import { madeRow, moreRow, prRow, rosterRow } from "./views/rows.ts";

function currentSection(): View {
  return when(
    "current",
    () => !!current(),
    () => VStack({ spacing: 8, alignment: "leading" }, [sectionHeader("THIS WORKSPACE"), currentPanel()]),
  );
}

// A faint line of its own, shown only while `text()` has something to say.
function faintLine(key: string, text: () => string, color: string = T.tertiary): View {
  return when(
    key,
    () => !!text(),
    () =>
      Text(text)
        .font(11)
        .color(color)
        .lineLimit(2)
        .paddingHorizontal(4)
        .frame({ maxWidth: "infinity", alignment: "leading" }),
  );
}

interface ListSection<T extends { key: string; last: boolean }> {
  label: string;
  key: string;
  count: () => number;
  rows: () => T[];
  row: (e: () => T) => View;
  /** Rows the cap left out, for a closing "+N more"; none by default. */
  more?: () => number;
  /** A faint line under the heading; none by default. */
  note?: () => string;
}

// A heading with its count, over a card of rows only while there are some,
// the card ending in "+N more" when the list was cut.
function listSection<T extends { key: string; last: boolean }>(s: ListSection<T>): View {
  const more = s.more ?? (() => 0);
  return VStack({ spacing: 8, alignment: "leading" }, [
    sectionHeader(s.label, () => String(s.count())),
    ...(s.note ? [faintLine(s.key + "-note", s.note)] : []),
    when(
      s.key,
      () => s.rows().length > 0,
      () =>
        panel([
          ForEach({ items: s.rows, key: (e) => e.key }, (e) => s.row(e)),
          when(
            s.key + "-more",
            () => more() > 0,
            () => moreRow(more, () => true),
          ),
        ]),
    ),
  ]);
}

sidebar(
  () =>
    VStack({ spacing: 18, alignment: "leading" }, [
      faintLine("state-notice", stateNotice, T.clayText),
      currentSection(),
      listSection({
        label: "WORKING",
        key: "working",
        count: () => roster().run.length,
        rows: workingRows,
        row: rosterRow,
      }),
      listSection({ label: "IDLE", key: "idle", count: () => roster().idle.length, rows: idleRows, row: rosterRow }),
      listSection({
        label: "PULL REQUESTS",
        key: "prs",
        count: prCount,
        rows: prs,
        row: prRow,
        more: prMore,
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
            more: madeMore,
          }),
      ),
      faintLine("empty-note", emptyNote),
      Spacer(),
    ])
      .paddingHorizontal(14)
      .paddingVertical(14),
  { surface: "glass" },
);
