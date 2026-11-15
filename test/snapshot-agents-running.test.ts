// Scene: the agents panel for a selected workspace whose chat is idle
// while its background work runs (#360): the native core's saved verdict
// counts a shell and an agent, so the head says "Running 4m · 1 shell,
// 1 agent" in working blue, as the card on the left does, and the chat's
// row says "running 4m". A second chat in the workspace is idle with no
// verdict of its own, so it stays Idle. Fixture data only; see
// test/support/snapshot.ts.

import { it } from "node:test";
import { ago, seed, snapshotScene } from "./support/snapshot.ts";

const r = seed({
  state: {
    names: { c1: { name: "Background work 6", from: "prompt" } },
    running: {
      here: {
        agent: "c1",
        since: ago(240),
        counts: [
          { type: "shell", n: 1 },
          { type: "subagent", n: 1 },
        ],
      },
    },
  },
});
const { agent, ws } = await import("./support/fixtures.ts");
await import("../src/agents/index.ts");
const { T } = await import("../src/agents/theme.ts");

it("the agents panel while background work runs", () => {
  r.data.selectedId = "here";
  r.data.workspaces = [
    ws("here", {
      title: "Background verdict",
      selected: true,
      directory: "/Users/jon/dev/app-one",
      branch: "bg-panel-verdict",
      latestMessage: "Started the tests in the background; I will report when they finish.",
      agents: [
        agent("idle", { id: "c1", name: "Claude", lastActivityAt: ago(90) }),
        agent("idle", { name: "Claude", title: "Check the card words", lastActivityAt: ago(600) }),
      ],
    }),
  ];
  snapshotScene("agents-running", r, T, "agents");
});
