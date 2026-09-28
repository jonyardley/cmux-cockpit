// Scene: the tidy strip at the foot of the cockpit, with merged worktrees in
// the cockpit's own repo and another. Fixture data only; see test/support/snapshot.ts.

import { it } from "node:test";
import type { SavedPr } from "../scripts/state-config.ts";
import { seed, snapshotScene } from "./support/snapshot.ts";

(globalThis as Record<string, unknown>).__COCKPIT_ROOT__ = "/Users/jon/.config/cockpit";
const merged = (branch: string): SavedPr => ({
  url: "https://github.com/o/r/pull/1",
  number: 1,
  status: "merged",
  branch,
});

const r = seed({
  projects: [
    { match: "/dev/app", name: "App", color: "#D97757", icon: "star.fill", root: "/Users/jon/Dev/app" },
    {
      match: "/.config/cockpit",
      name: "Cockpit",
      color: "#6A9BCC",
      icon: "cube.fill",
      root: "/Users/jon/.config/cockpit",
    },
  ],
  state: { prs: { strip: merged("strip"), featA: merged("feat-a"), featB: merged("feat-b") } },
});
const { ws } = await import("./support/fixtures.ts");
await import("../src/cockpit/index.ts");
const { C } = await import("../src/cockpit/theme.ts");

it("the tidy strip", () => {
  r.data.workspaces = [
    ws("strip", { directory: "/Users/jon/.config/cockpit-worktrees/strip", branch: "strip" }),
    ws("featA", { directory: "/Users/jon/Dev/app-worktrees/feat-a", branch: "feat-a" }),
    ws("featB", { directory: "/Users/jon/Dev/app-worktrees/feat-b", branch: "feat-b" }),
  ];
  snapshotScene("tidy-strip", r, C);
});
