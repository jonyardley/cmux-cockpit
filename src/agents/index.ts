// agents: Jon's right panel. Four sections over live workspace/agent data:
//   This workspace - the selected workspace in detail (views/current.ts).
//   Waiting on you - workspaces with a needs_input agent, latest message,
//                    Jump (select + focus surface). No Allow/Deny here: that
//                    needs the real diff/tool-call payload, which this data
//                    context does not carry, so it is not faked.
//   Running        - working agents in other workspaces, longest-running
//                    first, then idle agents dimmed and collapsed behind
//                    "N more idle".
//   Pull requests  - every PR across workspaces, tap opens the url.
//
//   cmux right-sidebar set custom agents

import { when } from "../shared/ui.ts";
import { current, prs, roster, runningRows, waiting } from "./model.ts";
import { T } from "./theme.ts";
import { currentPanel } from "./views/current.ts";
import { emptyRow, panel, sectionHeader } from "./views/parts.ts";
import { prRow, rosterRow, waitingRow } from "./views/rows.ts";

sidebar(
  () =>
    VStack({ spacing: 18, alignment: "leading" }, [
      when(
        "current",
        () => !!current(),
        () => VStack({ spacing: 8, alignment: "leading" }, [sectionHeader("THIS WORKSPACE"), currentPanel()]),
      ),

      VStack({ spacing: 8, alignment: "leading" }, [
        sectionHeader("WAITING ON YOU", () => String(waiting().length), T.clay),
        panel([
          ForEach({ items: waiting, key: (e) => e.key }, waitingRow),
          when(
            "waiting-empty",
            () => waiting().length === 0,
            () => emptyRow("Nothing waiting"),
          ),
        ]),
      ]),

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
