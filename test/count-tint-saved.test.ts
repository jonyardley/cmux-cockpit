// A header's count pill takes the hue of its most urgent session: needs you,
// then asking, then working; finished, idle and no agent leave it grey.
// __STATE__ holds one saved ask and is set before the renderer import, as in
// asking-saved.test.ts.

import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

(globalThis as Record<string, unknown>).__STATE__ = {
  dismissed: {},
  projectOverride: {},
  projects: {},
  prs: {},
  ownPrs: {},
  subagents: {},
  published: {},
  asking: { ask: { reason: "allow git push?", epoch: 1000 } },
  ui: {},
};

const { installRenderer } = await import("./support/renderer.ts");
const r = installRenderer();
const { agent, group, ws } = await import("./support/fixtures.ts");
const status = await import("../src/cockpit/status.ts");
const model = await import("../src/cockpit/model.ts");
const { C } = await import("../src/cockpit/theme.ts");
const { QUIET_PILL } = await import("../src/shared/ui.ts");
const { laneByKey } = await import("../src/cockpit/lanes.ts");

// One workspace per urgency. The ask began with the saved one, so it reads amber.
const needsWs = () => ws("needs", { agents: [agent("needs_input", { sinceEpoch: 1000 })] });
const askWs = () => ws("ask", { agents: [agent("needs_input", { sinceEpoch: 1000, lastActivityAt: 1000 })] });
const workingWs = () => ws("working", { agents: [agent("working", { sinceEpoch: 1000 })] });
const idleWs = () => ws("idle", { agents: [agent("idle"), agent("ended")] });

beforeEach(() => {
  r.data.epoch = 1060;
  r.data.groups = [];
  r.data.workspaces = [];
});

describe("urgencyOf", () => {
  it("reads needs you, asking and working by statusInfo's order", () => {
    assert.equal(status.urgencyOf(needsWs()), "needs");
    assert.equal(status.urgencyOf(askWs()), "asking");
    assert.equal(status.urgencyOf(workingWs()), "working");
  });

  it("leaves finished, idle and no agent quiet", () => {
    assert.equal(status.urgencyOf(idleWs()), "quiet");
    assert.equal(status.urgencyOf(ws("none")), "quiet");
    assert.equal(status.urgencyOf(undefined), "quiet");
  });
});

describe("mostUrgent", () => {
  it("ranks needs you over asking over working", () => {
    assert.equal(status.mostUrgent([workingWs(), askWs(), needsWs(), idleWs()]), "needs");
    assert.equal(status.mostUrgent([idleWs(), workingWs(), askWs()]), "asking");
    assert.equal(status.mostUrgent([idleWs(), workingWs()]), "working");
  });

  it("is quiet with nothing urgent, or nothing at all", () => {
    assert.equal(status.mostUrgent([idleWs(), ws("none")]), "quiet");
    assert.equal(status.mostUrgent([]), "quiet");
  });
});

describe("countColors", () => {
  it("tints the pill by its most urgent session's hue", () => {
    assert.deepEqual(status.countColors([needsWs()]), { bg: C.clayCount, fg: C.clayText });
    assert.deepEqual(status.countColors([askWs()]), { bg: C.amberCount, fg: C.amberText });
    assert.deepEqual(status.countColors([workingWs()]), { bg: C.blueCount, fg: C.blueText });
  });

  it("is the grey pill with nothing urgent", () => {
    assert.deepEqual(status.countColors([idleWs()]), QUIET_PILL);
    assert.deepEqual(QUIET_PILL, { bg: C.countBg, fg: C.metaText });
  });
});

describe("lane and project count pills", () => {
  function seed(): void {
    r.data.groups = [
      group("g-main", "Main activity", { anchorId: "anchor-main" }),
      group("g-parked", "Parked", { anchorId: "anchor-parked" }),
    ];
    r.data.workspaces = [
      // A generated anchor has no card, so it is neither counted nor tinted.
      ws("anchor-main", { title: "Main activity", group: "g-main" }),
      { ...workingWs(), group: "g-main", directory: "/Users/coder/dev/app-two" },
      { ...idleWs(), group: "g-main", directory: "/Users/coder/dev/app-two" },
      ws("anchor-parked", { title: "Parked", group: "g-parked" }),
      { ...needsWs(), group: "g-parked", directory: "/Users/coder/dev/app-three" },
    ];
  }

  it("lists the same cards the lane counts, and tints by them", () => {
    seed();
    assert.deepEqual(
      model.laneWorkspaces("main").map((w) => w.id),
      ["working", "idle"],
    );
    assert.equal(model.laneCount("main"), 2);
    assert.deepEqual(model.laneCountColors("main"), { bg: C.blueCount, fg: C.blueText });
    assert.deepEqual(model.laneCountColors("parked"), { bg: C.clayCount, fg: C.clayText });
    assert.deepEqual(model.laneCountColors("review"), QUIET_PILL);
  });

  it("keeps the tint while the lane is folded", () => {
    seed();
    const parked = laneByKey("parked");
    if (!model.isCollapsed(parked)) model.toggleLane(parked);
    assert.equal(model.isCollapsed(parked), true);
    assert.deepEqual(model.laneCountColors("parked"), { bg: C.clayCount, fg: C.clayText });
  });

  it("lists the same cards the project counts, and tints by them", () => {
    seed();
    const two = r.data.workspaces?.find((w) => w.id === "working");
    const three = r.data.workspaces?.find((w) => w.id === "needs");
    if (!two || !three) throw new Error("fixture");
    const k = model.projectKey(two);
    assert.deepEqual(
      model.projectWorkspaces(k).map((w) => w.id),
      ["working", "idle"],
    );
    assert.equal(model.projectCount(k), 2);
    assert.deepEqual(model.projectCountColors(k), { bg: C.blueCount, fg: C.blueText });
    assert.deepEqual(model.projectCountColors(model.projectKey(three)), { bg: C.clayCount, fg: C.clayText });
  });
});
