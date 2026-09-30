// Scene: the cockpit's lanes with a card in every state, each lane at its
// own density, and a working card under the folded Parked header. Fixture data only; see test/support/snapshot.ts.

import { it } from "node:test";
import { ago, EPOCH, seed, snapshotScene } from "./support/snapshot.ts";

const r = seed({
  state: {
    asking: { asking: { reason: "allow git push?", epoch: EPOCH - 120 } },
    subagents: {},
  },
});
const { agent, group, ws } = await import("./support/fixtures.ts");
await import("../src/cockpit/index.ts");
const { C } = await import("../src/cockpit/theme.ts");

it("lanes: every card state", () => {
  r.data.groups = [
    group("g-main", "Main activity", { anchorId: "anchor-main" }),
    group("g-review", "For review", { anchorId: "anchor-review" }),
    group("g-bg", "Background", { anchorId: "anchor-bg" }),
    group("g-parked", "Parked", { anchorId: "anchor-parked" }),
  ];
  r.data.selectedId = "selected";
  r.data.workspaces = [
    ws("anchor-main", { title: "Main activity", group: "g-main" }),
    ws("needs", {
      title: "Chip colours",
      group: "g-main",
      agents: [agent("needs_input", { sinceEpoch: ago(300), lastActivityAt: ago(300) })],
      latestMessage: "Which green should the ready chip use?",
    }),
    ws("asking", {
      title: "Release notes",
      group: "g-main",
      agents: [agent("needs_input", { sinceEpoch: ago(120), lastActivityAt: ago(120) })],
    }),
    ws("working", {
      title: "Snapshot tests",
      group: "g-main",
      branch: "snapshot-tests",
      dirty: true,
      pr: {
        number: 130,
        status: "open",
        draft: true,
        url: "https://github.com/o/r/pull/130",
        additions: 342,
        deletions: 17,
      },
      agents: [
        agent("working", {
          sinceEpoch: ago(840),
          lastActivityAt: ago(30),
          children: [{ id: "run1", label: "Explore views", running: true, startedEpoch: ago(60) }],
        }),
      ],
      progress: { value: 0.4, label: "Tests" },
      latestMessage: "Recording the view tree as text.",
    }),
    ws("quiet", {
      title: "Long build",
      group: "g-main",
      agents: [agent("working", { sinceEpoch: ago(2400), lastActivityAt: ago(1020) })],
    }),
    ws("ready", {
      title: "Tidy strip",
      group: "g-main",
      unread: 2,
      agents: [agent("idle", { sinceEpoch: ago(360), lastActivityAt: ago(360) })],
      latestMessage: "Done: the strip now groups by repo.",
    }),
    // No time in its status line, so the full card keeps the age top right.
    ws("untimed", {
      title: "Untimed card",
      group: "g-main",
      pinned: true,
      latestAt: ago(300),
      agents: [agent("idle")],
    }),
    ws("selected", {
      title: "Selected card",
      group: "g-main",
      selected: true,
      agents: [agent("working", { sinceEpoch: ago(60), lastActivityAt: ago(10) })],
    }),
    ws("anchor-review", { title: "For review", group: "g-review" }),
    ws("ended", {
      title: "Ended agent",
      group: "g-review",
      pinned: true,
      agents: [agent("ended", { sinceEpoch: ago(900), lastActivityAt: ago(900) })],
    }),
    ws("idle", {
      title: "Left off",
      group: "g-review",
      unread: 1,
      latestPrompt: "Look at the merge verdicts next",
      agents: [agent("idle", { sinceEpoch: ago(5000) })],
    }),
    ws("anchor-bg", { title: "Background", group: "g-bg" }),
    ws("none", { title: "No agent", group: "g-bg", branch: "main" }),
    ws("anchor-parked", { title: "Parked", group: "g-parked" }),
    // Working under the folded Parked header, so the header shows its dot.
    ws("parked", {
      title: "Parked card",
      group: "g-parked",
      agents: [agent("working", { sinceEpoch: ago(300), lastActivityAt: ago(5) })],
    }),
    ws("loose", {
      title: "Loose workspace",
      pinned: true,
      agents: [agent("working", { sinceEpoch: ago(200), lastActivityAt: ago(20) })],
    }),
  ];
  snapshotScene("lanes", r, C, "cockpit");
});
