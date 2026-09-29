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
const { QUIET_PILL, countTint } = await import("../src/shared/ui.ts");
const { laneByKey } = await import("../src/cockpit/lanes.ts");

// One workspace per urgency. The ask began with the saved one, so it reads amber.
const needsWs = () => ws("needs", { agents: [agent("needs_input", { sinceEpoch: 1000 })] });
const askWs = () => ws("ask", { agents: [agent("needs_input", { sinceEpoch: 1000, lastActivityAt: 1000 })] });
const workingWs = () => ws("working", { agents: [agent("working", { sinceEpoch: 1000 })] });
const idleWs = () => ws("idle", { agents: [agent("idle"), agent("ended")] });
// Working, but silent past QUIET_SECS: the hollow blue dot, still working.
const quietWs = () => ws("quiet", { agents: [agent("working", { sinceEpoch: 100, lastActivityAt: 400 })] });
// Finished with output unread: Ready, the finished green.
const readyWs = () => ws("ready", { unread: 2, agents: [agent("idle", { lastActivityAt: 1000 })] });

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

  it("reads a quiet working agent as working, and Ready as quiet", () => {
    assert.equal(status.statusInfo(quietWs()).ring, C.blue);
    assert.equal(status.urgencyOf(quietWs()), "working");
    assert.equal(status.isReady(readyWs()), true);
    assert.equal(status.urgencyOf(readyWs()), "quiet");
  });

  it("is always the urgency the card's status carries, so the pill and the dot agree", () => {
    for (const w of [needsWs(), askWs(), workingWs(), idleWs(), quietWs(), readyWs(), ws("none")])
      assert.equal(status.urgencyOf(w), status.statusInfo(w).urgency, w.id);
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

describe("countTint, the shared rule both sides tint a count pill by", () => {
  it("gives each urgency its hue's pill, and quiet the grey one", () => {
    assert.deepEqual(countTint("needs"), { bg: C.clayCount, fg: C.clayText });
    assert.deepEqual(countTint("asking"), { bg: C.amberCount, fg: C.amberText });
    assert.deepEqual(countTint("working"), { bg: C.blueCount, fg: C.blueText });
    assert.equal(countTint("quiet"), QUIET_PILL);
  });

  it("is where the cockpit's header tint comes from", () => {
    assert.equal(status.countColors([workingWs()]), countTint("working"));
    assert.equal(status.headerStatus([needsWs()], false).tint, countTint("needs"));
  });
});

describe("mostUrgentOf", () => {
  it("picks the first workspace at the highest urgency, for a folded header's dot", () => {
    const later = { ...workingWs(), id: "working-2" };
    assert.equal(status.mostUrgentOf([idleWs(), workingWs(), later])?.id, "working");
    assert.equal(status.mostUrgentOf([workingWs(), askWs(), needsWs()])?.id, "needs");
  });

  it("is undefined when every workspace is quiet, so a folded header shows no dot", () => {
    assert.equal(status.mostUrgentOf([idleWs(), readyWs(), ws("none")]), undefined);
    assert.equal(status.mostUrgentOf([]), undefined);
  });
});

describe("headerStatus", () => {
  it("shows the lead's dot while folded, from the same walk as the tint", () => {
    const shown = status.headerStatus([idleWs(), workingWs(), askWs()], true);
    assert.equal(shown.dot?.id, "ask");
    assert.deepEqual(shown.tint, status.countColors([idleWs(), workingWs(), askWs()]));
  });

  it("shows no dot while open, and keeps the tint", () => {
    const shown = status.headerStatus([workingWs(), needsWs()], false);
    assert.equal(shown.dot, undefined);
    assert.deepEqual(shown.tint, { bg: C.clayCount, fg: C.clayText });
  });

  it("shows no dot when every card is quiet, folded or not, and a grey tint", () => {
    assert.equal(status.headerStatus([idleWs(), readyWs()], true).dot, undefined);
    assert.equal(status.headerStatus([], true).dot, undefined);
    assert.deepEqual(status.headerStatus([idleWs()], true).tint, QUIET_PILL);
  });

  it("tints as countColors does for every urgency", () => {
    for (const cards of [[needsWs()], [askWs()], [workingWs()], [idleWs()], []])
      assert.deepEqual(status.headerStatus(cards, true).tint, status.countColors(cards));
  });
});

describe("lane and project count pills", () => {
  // Four older asks in Unsorted fill the Needs you strip, so a later one is
  // past its cap and keeps its card, count and tint in its lane.
  const fullStrip = () =>
    ["s1", "s2", "s3", "s4"].map((id) => ws(id, { agents: [agent("needs_input", { sinceEpoch: 900 })] }));

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
    assert.deepEqual(status.countColors(model.laneWorkspaces("main")), { bg: C.blueCount, fg: C.blueText });
    assert.deepEqual(status.countColors(model.laneWorkspaces("review")), QUIET_PILL);
  });

  it("leaves a card the Needs you strip lists out of its lane's count and tint", () => {
    seed();
    assert.deepEqual(model.laneWorkspaces("parked"), []);
    assert.deepEqual(status.countColors(model.laneWorkspaces("parked")), QUIET_PILL);
  });

  it("counts and tints by a card past the strip's cap, which keeps its lane", () => {
    seed();
    r.data.workspaces?.push(...fullStrip());
    assert.deepEqual(
      model.laneWorkspaces("parked").map((w) => w.id),
      ["needs"],
    );
    assert.deepEqual(status.countColors(model.laneWorkspaces("parked")), { bg: C.clayCount, fg: C.clayText });
  });

  it("keeps the tint while the lane is folded", () => {
    seed();
    r.data.workspaces?.push(...fullStrip());
    const parked = laneByKey("parked");
    if (!model.isCollapsed(parked)) model.toggleLane(parked);
    assert.equal(model.isCollapsed(parked), true);
    assert.deepEqual(status.countColors(model.laneWorkspaces("parked")), { bg: C.clayCount, fg: C.clayText });
  });

  it("lists the same cards the project counts, and tints by them", () => {
    seed();
    r.data.workspaces?.push(...fullStrip());
    const two = r.data.workspaces?.find((w) => w.id === "working");
    const three = r.data.workspaces?.find((w) => w.id === "needs");
    if (!two || !three) throw new Error("fixture");
    const k = model.projectKey(two);
    assert.deepEqual(
      model.projectWorkspaces(k).map((w) => w.id),
      ["working", "idle"],
    );
    assert.deepEqual(status.countColors(model.projectWorkspaces(k)), { bg: C.blueCount, fg: C.blueText });
    assert.deepEqual(status.countColors(model.projectWorkspaces(model.projectKey(three))), {
      bg: C.clayCount,
      fg: C.clayText,
    });
  });
});
