// Scene: the Projects view, with cards grouped under two projects, one card
// outside any project, one card quoting its saved move, a merged card offering Park and Close,
// and the third project folded into the quiet list.
// Fixture data only; see test/support/snapshot.ts.

import { it } from "node:test";
import { ago, seed, snapshotScene } from "./support/snapshot.ts";

const r = seed({
  state: {
    ui: { mode: "projects" },
    moves: { "one-b": { text: "Read the draft in #142 and say go.", epoch: ago(90), session: "s-one-b" } },
  },
});
const { agent, ws } = await import("./support/fixtures.ts");
await import("../src/cockpit/index.ts");
const { C } = await import("../src/cockpit/theme.ts");

it("the projects view", () => {
  r.data.workspaces = [
    ws("one-a", {
      title: "One: parser rewrite for the streaming tokeniser",
      directory: "/Users/jon/dev/app-one",
      branch: "parser-streaming-tokeniser",
      pr: {
        number: 148,
        status: "open",
        draft: true,
        url: "https://github.com/o/r/pull/148",
        additions: 342,
        deletions: 17,
      },
      agents: [agent("working", { sinceEpoch: ago(420), lastActivityAt: ago(15) })],
    }),
    ws("one-b", {
      title: "One: docs",
      directory: "/Users/jon/dev/app-one/docs",
      latestAt: ago(150),
      agents: [agent("needs_input", { id: "s-one-b", kind: "claude", sinceEpoch: ago(90), lastActivityAt: ago(90) })],
    }),
    ws("two", {
      title: "Two: release",
      directory: "/Users/jon/.config/app-two",
      branch: "main",
      pr: { number: 12, status: "open", url: "https://github.com/o/r/pull/12" },
      unread: 1,
      pinned: true,
      agents: [agent("idle", { sinceEpoch: ago(600), lastActivityAt: ago(600) })],
    }),
    ws("two-merged", {
      title: "Two: changelog",
      directory: "/Users/jon/.config/app-two",
      branch: "changelog-for-release",
      pr: { number: 14, status: "merged", url: "https://github.com/o/r/pull/14" },
      agents: [agent("idle", { sinceEpoch: ago(900), lastActivityAt: ago(900) })],
    }),
    ws("elsewhere", { title: "Scratch", directory: "/tmp/scratch" }),
  ];
  snapshotScene("projects", r, C, "cockpit");
});
