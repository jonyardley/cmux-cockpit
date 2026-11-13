// Scene: the agents panel for a selected workspace whose chat ended its
// turn a minute ago on a line asking Jon something, while a shell it
// started four minutes ago still runs (Jon's 13 November report). The
// native core's saved verdict counts the shell, but the head says "Your
// turn 1m" in clay with the question block, as the Cockpit card does
// (#374), not "Running 4m · 1 shell". Fixture data only; see
// test/support/snapshot.ts.

import { it } from "node:test";
import { ago, seed, snapshotScene } from "./support/snapshot.ts";

const r = seed({
  state: {
    names: { c1: { name: "Left panel redraw", from: "prompt" } },
    moves: {
      here: { text: "answer yes or no once the left panel redraws.", epoch: ago(60), session: "c1" },
    },
    running: { here: { agent: "c1", since: ago(240), counts: [{ type: "shell", n: 1 }] } },
  },
});
const { agent, ws } = await import("./support/fixtures.ts");
await import("../src/agents/index.ts");
const { T } = await import("../src/agents/theme.ts");

it("the agents panel on a turn that asks Jon while background work runs", () => {
  r.data.selectedId = "here";
  r.data.workspaces = [
    ws("here", {
      title: "Your turn over Running",
      selected: true,
      directory: "/Users/jon/dev/app-one",
      branch: "your-turn-running",
      latestAt: ago(300),
      latestMessage: "Your move: answer yes or no once the left panel redraws.",
      agents: [
        agent("idle", { id: "c1", kind: "claude", name: "Claude", sinceEpoch: ago(60), lastActivityAt: ago(60) }),
      ],
    }),
  ];
  snapshotScene("agents-your-turn", r, T, "agents");
});
