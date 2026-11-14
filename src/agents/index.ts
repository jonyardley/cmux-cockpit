// agents: Jon's right panel. Each fact lives in one place: the cockpit on
// the left is the roster of every workspace, so this panel is only about the
// selected workspace, plus what belongs to no single card. Two tabs at the
// top (#397), remembered per workspace until reload: Now, the sections
// below, and Details (views/details.ts), the selected workspace's whole
// story: what the Cockpit has waiting on Jon, every session, helper and
// check, its move, ports and pages.
// Now's sections:
//   This workspace - the selected workspace in detail (views/current.ts),
//                    headed with its project; its name is the highlighted
//                    card on the left. What that card has no room for: its
//                    agent's latest message, running helpers, ports, the PR
//                    and its checks, and a faint branch footer. When its
//                    agent needs you, or a wait the Cockpit saved
//                    (src/shared/waits.ts), the card carries the question,
//                    and Dismiss for an agent's own ask (local to this
//                    panel, src/shared/needs.ts; the Cockpit dismisses its
//                    saved waits); no
//                    Open chat, as its chat is the one on screen (#383).
//                    No Allow/Deny: that needs the real diff/tool-call
//                    payload, which this data context does not carry, so it
//                    is not faked. Other workspaces that need you do not
//                    appear in this panel at all, by design: the cockpit's
//                    Needs you strip is their one home.
//   Pull requests  - every PR across workspaces, tap opens the url. A faint
//                    line under the heading says when the saved PR data is
//                    old or gh is down, and those chips dim (#78).
//   Made here      - pages and docs agents published (#52): this workspace's
//                    first, then the latest few from others; tap opens it.
//   Context        - how full this workspace's chat is, and the plan's
//                    5-hour and weekly usage (context.ts); hidden until a
//                    status line has reported.
// Counts are the real totals, and a capped list ends in "+N more" (#80).
// Pull requests shows its heading and count when empty; Made here, and the
// card's Helpers, fold into one faint line at the bottom instead. When
// config/state.json could not be read at build, a line at the top says so
// rather than the panel just looking empty (#78).
//
//   cmux right-sidebar set custom agents

import { stateNotice } from "../shared/freshness.ts";
import { motionList, when } from "../shared/ui.ts";
import { contextMeters } from "./context.ts";
import { tabOf } from "./details.ts";
import { toggleExpanded } from "./lists.ts";
import { emptyNote, madeCount, madeFoot, madeHere } from "./made.ts";
import { current, currentHeading } from "./model.ts";
import { prCount, prFoot, prNote, prs } from "./pr-list.ts";
import { T } from "./theme.ts";
import { meterRow } from "./views/context.ts";
import { currentPanel } from "./views/current.ts";
import { detailsPanel } from "./views/details.ts";
import { panel, sectionHeader } from "./views/parts.ts";
import { madeRow, prRow } from "./views/rows.ts";
import { faintNote, listSection } from "./views/sections.ts";
import { tabSwitch } from "./views/tabs.ts";

function currentSection(): View {
  return when(
    "current",
    () => !!current(),
    () => VStack({ spacing: 8, alignment: "leading" }, [sectionHeader(currentHeading), currentPanel()]),
  );
}

// Today's panel: the selected workspace, every PR, what agents made, and
// the Context card.
function nowPanel(): View {
  return VStack({ spacing: 18, alignment: "leading" }, [
    currentSection(),
    listSection({
      label: "PULL REQUESTS",
      key: "prs",
      count: prCount,
      rows: prs,
      row: prRow,
      foot: { text: prFoot, toggle: () => toggleExpanded("prs") },
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
          foot: { text: madeFoot, toggle: () => toggleExpanded("made") },
        }),
    ),
    faintNote("empty-note", emptyNote),
    when(
      "context-section",
      () => contextMeters().length > 0,
      () =>
        VStack({ spacing: 8, alignment: "leading" }, [
          sectionHeader("CONTEXT"),
          panel([motionList({ items: contextMeters, key: (m) => m.key, spacing: 0 }, meterRow)]),
        ]),
    ),
  ]).frame({ maxWidth: "infinity", alignment: "leading" });
}

// The switch, then the chosen tab, each mounted only while chosen.
sidebar(
  () =>
    VStack({ spacing: 18, alignment: "leading" }, [
      tabSwitch(),
      faintNote("state-notice", stateNotice, T.clayText),
      when("tab-now", () => tabOf() === "now", nowPanel),
      when("tab-details", () => tabOf() === "details", detailsPanel),
      Spacer(),
    ])
      .paddingHorizontal(14)
      .paddingVertical(14),
  { surface: "glass" },
);
