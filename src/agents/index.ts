// agents: Jon's right panel. Three sections over live workspace/agent data:
//   This workspace - the selected workspace in detail (views/current.ts).
//                    When its agent needs you, the card carries the question,
//                    Answer (select + focus surface) and Dismiss (local to
//                    this panel, src/shared/needs.ts). No Allow/Deny: that
//                    needs the real diff/tool-call payload, which this data
//                    context does not carry, so it is not faked. Other
//                    workspaces that need you do not appear in this panel at
//                    all, by design: the cockpit's Needs you strip is their
//                    one home.
//   Running        - working agents in other workspaces, longest-running
//                    first, then idle agents dimmed and collapsed behind
//                    "N more idle".
//   Pull requests  - every PR across workspaces, tap opens the url.
//
//   cmux right-sidebar set custom agents

import { when } from "../shared/ui.ts";
import { current, prs, roster, runningRows } from "./model.ts";
import { currentPanel } from "./views/current.ts";
import { emptyRow, panel, sectionHeader } from "./views/parts.ts";
import { prRow, rosterRow } from "./views/rows.ts";

sidebar(
  () =>
    VStack({ spacing: 18, alignment: "leading" }, [
      when(
        "current",
        () => !!current(),
        () => VStack({ spacing: 8, alignment: "leading" }, [sectionHeader("THIS WORKSPACE"), currentPanel()]),
      ),

      VStack({ spacing: 8, alignment: "leading" }, [
        sectionHeader("RUNNING", () => String(roster().run.length)),
        panel([ForEach({ items: runningRows, key: (e) => e.key }, rosterRow)]),
      ]),

      VStack({ spacing: 8, alignment: "leading" }, [
        sectionHeader("PULL REQUESTS", () => String(prs().length)),
        panel([
          ForEach({ items: prs, key: (e) => e.key }, prRow),
          when(
            "prs-empty",
            () => prs().length === 0,
            () => emptyRow("No pull requests"),
          ),
        ]),
      ]),

      Spacer(),
    ])
      .paddingHorizontal(14)
      .paddingVertical(14),
  { surface: "glass" },
);
