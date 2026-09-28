// Scene: the Projects view, with cards grouped under two projects, one card
// outside any project, and the third project folded into the quiet list.
// Fixture data only; see test/support/snapshot.ts.

import { it } from "node:test";
import { EPOCH, seed, snapshotScene } from "./support/snapshot.ts";

const r = seed({ state: { ui: { mode: "projects" } } });
const { agent, ws } = await import("./support/fixtures.ts");
await import("../src/cockpit/index.ts");
const { C } = await import("../src/cockpit/theme.ts");

const ago = (s: number): number => EPOCH - s;

it("the projects view", () => {
  r.data.workspaces = [
    ws("one-a", {
      title: "One: parser",
      directory: "/Users/jon/dev/app-one",
      agents: [agent("working", { sinceEpoch: ago(420), lastActivityAt: ago(15) })],
    }),
    ws("one-b", {
      title: "One: docs",
      directory: "/Users/jon/dev/app-one/docs",
      agents: [agent("needs_input", { sinceEpoch: ago(90), lastActivityAt: ago(90) })],
    }),
    ws("two", {
      title: "Two: release",
      directory: "/Users/jon/.config/app-two",
      unread: 1,
      agents: [agent("idle", { sinceEpoch: ago(600), lastActivityAt: ago(600) })],
    }),
    ws("elsewhere", { title: "Scratch", directory: "/tmp/scratch" }),
  ];
  snapshotScene("projects", r, C);
});
