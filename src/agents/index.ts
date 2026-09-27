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
//   Pull requests  - every PR across workspaces, tap opens the url.
//   Made here      - pages and docs agents published (#52): this workspace's
//                    first, then the latest few from others; tap opens it.
//                    Empty until the published hook is installed.
// An empty section is its heading and count alone, with no empty card.
//
//   cmux right-sidebar set custom agents

import { when } from "../shared/ui.ts";
import { current, idleRows, madeHere, prs, roster, workingRows } from "./model.ts";
import { currentPanel } from "./views/current.ts";
import { panel, sectionHeader } from "./views/parts.ts";
import { madeRow, prRow, rosterRow } from "./views/rows.ts";

function currentSection(): View {
  return when(
    "current",
    () => !!current(),
    () => VStack({ spacing: 8, alignment: "leading" }, [sectionHeader("THIS WORKSPACE"), currentPanel()]),
  );
}

// A heading with its count, over a card of rows only while there are some.
function listSection<T extends { key: string }>(
  label: string,
  key: string,
  count: () => number,
  rows: () => T[],
  row: (e: () => T) => View,
): View {
  return VStack({ spacing: 8, alignment: "leading" }, [
    sectionHeader(label, () => String(count())),
    when(
      key,
      () => rows().length > 0,
      () => panel([ForEach({ items: rows, key: (e) => e.key }, row)]),
    ),
  ]);
}

sidebar(
  () =>
    VStack({ spacing: 18, alignment: "leading" }, [
      currentSection(),
      listSection("WORKING", "working", () => roster().run.length, workingRows, rosterRow),
      listSection("IDLE", "idle", () => roster().idle.length, idleRows, rosterRow),
      listSection("PULL REQUESTS", "prs", () => prs().length, prs, prRow),
      listSection("MADE HERE", "made", () => madeHere().length, madeHere, madeRow),
      Spacer(),
    ])
      .paddingHorizontal(14)
      .paddingVertical(14),
  { surface: "glass" },
);
