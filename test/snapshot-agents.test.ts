// Scene: the agents panel for a selected workspace with a running helper,
// ports and a PR with checks, then every PR and what agents made. Fixture
// data only; see test/support/snapshot.ts.

import { it } from "node:test";
import { ago, seed, snapshotScene } from "./support/snapshot.ts";

const url = (n: number): string => `https://github.com/o/r/pull/${n}`;

const r = seed({
  state: {
    prs: {
      here: {
        url: url(12),
        number: 12,
        status: "open",
        branch: "snapshots",
        title: "Text snapshots for the sidebars",
        checks: [
          { name: "lint", state: "fail" },
          { name: "build", state: "pending" },
          { name: "test", state: "pass" },
        ],
      },
      other: { url: url(9), number: 9, status: "open", branch: "chips", title: "Ready chip", mergeable: true },
    },
    ownPrs: {
      [url(4)]: { url: url(4), number: 4, status: "open", branch: "old", title: "An orphaned PR", repo: "/r/.git" },
    },
    subagents: {
      here: [{ id: "t1", session: "s1", label: "Review the diff", startedEpoch: ago(90) }],
    },
    published: {
      "https://claude.ai/artifact/a1": {
        url: "https://claude.ai/artifact/a1",
        title: "Snapshot plan",
        kind: "doc",
        workspace: "here",
        epoch: ago(3600),
      },
      "https://claude.ai/artifact/a2": {
        url: "https://claude.ai/artifact/a2",
        title: "Chip palette",
        kind: "page",
        workspace: "other",
        epoch: ago(7200),
      },
    },
    poll: { okEpoch: ago(60) },
  },
});
const { agent, ws } = await import("./support/fixtures.ts");
await import("../src/agents/index.ts");
const { T } = await import("../src/agents/theme.ts");

it("the agents panel", () => {
  r.data.selectedId = "here";
  r.data.workspaces = [
    ws("here", {
      title: "Snapshot tests",
      selected: true,
      directory: "/Users/jon/dev/app-one",
      branch: "snapshots",
      ports: [5173],
      latestMessage: "Recorded six scenes; the lanes one is the longest.",
      agents: [agent("working", { id: "s1", sinceEpoch: ago(900), lastActivityAt: ago(20) })],
    }),
    ws("other", {
      title: "Chip colours",
      branch: "chips",
      agents: [agent("idle", { sinceEpoch: ago(300), lastActivityAt: ago(300) })],
    }),
  ];
  snapshotScene("agents", r, T);
});
