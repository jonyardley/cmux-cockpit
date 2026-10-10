// Issue #74: the Next button's queue, the capped Needs you strip, and cards
// sorted by state inside each lane without losing where a drop lands.

import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { installRenderer } from "./support/renderer.ts";

const r = installRenderer();
const { agent, group, ws } = await import("./support/fixtures.ts");
const model = {
  ...(await import("../src/cockpit/strip.ts")),
  ...(await import("../src/cockpit/lane-entries.ts")),
  ...(await import("../src/cockpit/next.ts")),
};
const drop = await import("../src/cockpit/drop.ts");
const state = await import("../src/cockpit/state.ts");

const now = () => r.data.epoch;
const asking = (ago: number) => [agent("needs_input", { sinceEpoch: now() - ago })];
const finished = (ago: number) => [agent("idle", { lastActivityAt: now() - ago, sinceEpoch: now() - ago })];
const working = () => [agent("working", { sinceEpoch: now() - 10 })];

function setup(workspaces: Workspace[]): void {
  r.data.epoch += 100;
  r.data.selectedId = null;
  r.data.groups = [group("g-main", "Main activity", { anchorId: "anchor-main" })];
  r.data.workspaces = [ws("anchor-main", { title: "Main activity", group: "g-main" }), ...workspaces];
  r.calls.length = 0;
  state.setMode("all");
  state.setDrag(null);
}

const byId = (id: string): Workspace => {
  const w = r.data.workspaces.find((x) => x.id === id);
  if (!w) throw new Error("fixture " + id);
  return w;
};
const queue = () => model.nextQueue().map((w) => w.id);
const step = () => {
  const s = model.nextStep();
  return s ? [s.target.id, s.position, s.total] : null;
};
// cmux publishes the selection a frame later; this is that frame.
const publishSelection = () => {
  const sel = r.calls.filter((c) => c.method === "workspace.select").at(-1);
  r.data.selectedId = typeof sel?.params.workspace_id === "string" ? sel.params.workspace_id : null;
  for (const w of r.data.workspaces) {
    w.selected = w.id === r.data.selectedId;
    // Opening a workspace marks its output read.
    if (w.selected) w.unread = 0;
  }
  // The sidebar's own read of the new selection retires its optimistic
  // override, so it cannot leak into the next test.
  const opened = r.data.workspaces.find((w) => w.selected);
  if (opened) state.isSelected(opened);
};
const press = () => {
  model.jumpNext();
  publishSelection();
};

describe("the Next queue", () => {
  beforeEach(() =>
    setup([
      ws("idle", { group: "g-main" }),
      ws("ready-new", { group: "g-main", unread: 1, agents: finished(60) }),
      ws("needs-new", { group: "g-main", agents: asking(30) }),
      ws("ready-old", { group: "g-main", unread: 2, agents: finished(600) }),
      ws("needs-old", { group: "g-main", agents: asking(300) }),
      ws("busy", { group: "g-main", agents: working() }),
    ]),
  );

  it("lists needs you, then Ready, each longest-waiting first, and nothing else", () => {
    assert.deepEqual(queue(), ["needs-old", "needs-new", "ready-old", "ready-new"]);
  });

  it("points at the most urgent first and says how far along it is", () => {
    assert.deepEqual(step(), ["needs-old", 1, 4]);
  });

  it("moves on with each press, then cycles back to the top", () => {
    press();
    assert.equal(r.data.selectedId, "needs-old");
    assert.deepEqual(step(), ["needs-new", 2, 4]);
    press();
    assert.deepEqual(step(), ["ready-old", 3, 4]);
    press();
    // Opening a Ready one clears it, so it drops out and the next slides up.
    assert.deepEqual(queue(), ["needs-old", "needs-new", "ready-new"]);
    assert.deepEqual(step(), ["ready-new", 3, 3]);
    press();
    assert.deepEqual(step(), ["needs-old", 1, 2]);
  });

  it("shows the move at once, before cmux publishes the selection", () => {
    model.jumpNext();
    assert.equal(r.calls.at(-1)?.method, "workspace.select");
    assert.deepEqual(step(), ["needs-new", 2, 4]);
    publishSelection();
  });

  it("moves on from whatever Jon opened himself", () => {
    r.data.selectedId = "needs-new";
    byId("needs-new").selected = true;
    assert.deepEqual(step(), ["ready-old", 3, 4]);
  });

  it("starts from the top again once Jon has moved off the queue", () => {
    press();
    press();
    press(); // ready-old, now read and off the queue
    r.data.selectedId = "busy";
    for (const w of r.data.workspaces) w.selected = w.id === "busy";
    assert.deepEqual(step(), ["needs-old", 1, 3]);
  });

  it("goes to the one after an opened Ready workspace even when one ahead leaves", () => {
    press();
    press();
    press(); // ready-old, now off the queue; ready-new followed it
    byId("needs-old").agents = [agent("working")];
    assert.deepEqual(queue(), ["needs-new", "ready-new"]);
    assert.deepEqual(step(), ["ready-new", 2, 2]);
  });

  it("forgets the last jump once Jon leaves it, so coming back later starts at the top", () => {
    press();
    press();
    press(); // ready-old
    r.data.selectedId = "busy";
    for (const w of r.data.workspaces) w.selected = w.id === "busy";
    assert.deepEqual(step(), ["needs-old", 1, 3]);
    r.data.selectedId = "ready-old";
    for (const w of r.data.workspaces) w.selected = w.id === "ready-old";
    assert.deepEqual(step(), ["needs-old", 1, 3]);
  });

  it("dates a Ready workspace by when it finished, not a later last activity (issue #98)", () => {
    byId("ready-new").agents = [agent("idle", { sinceEpoch: now() - 900, lastActivityAt: now() - 30 })];
    assert.deepEqual(queue(), ["needs-old", "needs-new", "ready-new", "ready-old"]);
  });

  it("dates a Ready workspace by its finished agent, not a fresh idle session beside it", () => {
    byId("ready-old").agents = [...finished(600), agent("idle", { sinceEpoch: now() - 5 })];
    assert.deepEqual(queue(), ["needs-old", "needs-new", "ready-old", "ready-new"]);
  });

  it("hides when the only one waiting is the one Jon is on", () => {
    setup([ws("n", { group: "g-main", agents: asking(60) }), ws("busy", { group: "g-main", agents: working() })]);
    assert.deepEqual(step(), ["n", 1, 1]);
    press();
    assert.equal(model.nextStep(), null);
  });

  it("is hidden when nothing needs Jon or is Ready", () => {
    setup([ws("idle", { group: "g-main" }), ws("busy", { group: "g-main", agents: working() })]);
    assert.equal(model.nextStep(), null);
    model.jumpNext();
    assert.deepEqual(r.calls, []);
  });
});

describe("the capped Needs you strip", () => {
  it("shows four rows and counts the rest", () => {
    setup(["a", "b", "c", "d", "e", "f"].map((id, i) => ws(id, { group: "g-main", agents: asking(600 - i * 60) })));
    assert.equal(model.needsList().length, 6);
    assert.deepEqual(
      model.needsShown().map((w) => w.id),
      ["a", "b", "c", "d"],
    );
    assert.equal(model.needsMore(), 2);
  });

  it("has no more line at four or fewer", () => {
    setup(["a", "b", "c", "d"].map((id) => ws(id, { group: "g-main", agents: asking(60) })));
    assert.equal(model.needsShown().length, 4);
    assert.equal(model.needsMore(), 0);
  });
});

describe("cards sorted by state inside a lane", () => {
  const lane = () => model.flatEntries().flatMap((e) => (e.kind === "ws" ? [e.wsId] : []));

  // Four older asks fill the Needs you strip, so n1 is past its cap and
  // keeps its card in the lane (strip.ts's inStrip); the four leave
  // placeholders in Unsorted, which lane() leaves out as it reads cards.
  const fullStrip = ["q1", "q2", "q3", "q4"].map((id) => ws(id, { agents: asking(600) }));

  beforeEach(() =>
    setup([
      ws("i1", { group: "g-main" }),
      ws("w1", { group: "g-main", agents: working() }),
      ws("i2", { group: "g-main" }),
      ws("r1", { group: "g-main", unread: 1, agents: finished(60) }),
      ws("n1", { group: "g-main", agents: asking(60) }),
      ws("i3", { group: "g-main" }),
      ...fullStrip,
    ]),
  );

  it("puts needs you, then Ready, then working, then the rest, keeping tab order within a state", () => {
    assert.deepEqual(lane(), ["n1", "r1", "w1", "i1", "i2", "i3"]);
    assert.deepEqual(
      ["n1", "r1", "w1", "i1"].map((id) => model.stateRank(byId(id))),
      [0, 2, 3, 4],
    );
  });

  it("puts a pinned card under needs you and above Ready", () => {
    byId("i1").pinned = true;
    assert.deepEqual(lane(), ["n1", "i1", "r1", "w1", "i2", "i3"]);
    byId("n1").pinned = true;
    assert.deepEqual(lane(), ["n1", "i1", "r1", "w1", "i2", "i3"]);
    assert.equal(model.stateRank(byId("n1")), 0);
    delete byId("i1").pinned;
    delete byId("n1").pinned;
    assert.deepEqual(lane(), ["n1", "r1", "w1", "i1", "i2", "i3"]);
  });

  it("re-sorts a card when its state changes", () => {
    byId("i3").agents = asking(10);
    assert.deepEqual(lane(), ["n1", "i3", "r1", "w1", "i1", "i2"]);
  });

  // Rows: h:main, n1, r1, w1, i1, i2, i3, h:unsorted. Dragging i3 leaves
  // h:main, n1, r1, w1, i1, i2, h:unsorted.
  it("anchors a drop before the nearest card below in the same state", () => {
    // Slot 4 sits between w1 (working) and i1 (idle): i3 is idle, so it goes before i1.
    assert.deepEqual(drop.resolveDrop("w:i3", 4), { laneKey: "main", nextRef: "i1", prevRef: null });
    // Dragging i1 up leaves h:main, n1, r1, w1, i2, i3; slot 5 is between i2 and i3.
    assert.deepEqual(drop.resolveDrop("w:i1", 5), { laneKey: "main", nextRef: "i3", prevRef: null });
  });

  it("files a drop after its peer above when the card below is in another state", () => {
    // Drag w1: rows h:main, n1, r1, i1, i2, i3. Make r1 working too, so it is w1's peer above i1.
    byId("r1").agents = working();
    byId("r1").unread = 0;
    // Tab order puts r1 after w1, so "before i1" would sit w1 above r1. After r1 is right.
    assert.deepEqual(drop.resolveDrop("w:w1", 3), { laneKey: "main", nextRef: null, prevRef: "r1" });
    drop.handleMove("w:w1", 3);
    assert.deepEqual(lane(), ["n1", "r1", "w1", "i1", "i2", "i3"]);
  });

  it("lands a card among its peers where it was let go", () => {
    // Drag i3 to just under i1 (slot 5, between i1 and i2 once i3 is lifted).
    drop.handleMove("w:i3", 5);
    assert.deepEqual(lane(), ["n1", "r1", "w1", "i1", "i3", "i2"]);
  });

  it("lands a card let go inside another state's run first among its peers below", () => {
    // i1 dropped at the very top, under h:main: before i2, the first idle card below.
    assert.deepEqual(drop.resolveDrop("w:i1", 1), { laneKey: "main", nextRef: "i2", prevRef: null });
    drop.handleMove("w:i1", 1);
    assert.deepEqual(lane(), ["n1", "r1", "w1", "i1", "i2", "i3"]);
    // i3 to the top: now first of the idle cards.
    drop.handleMove("w:i3", 1);
    assert.deepEqual(lane(), ["n1", "r1", "w1", "i3", "i1", "i2"]);
  });

  it("lands a card let go below every peer last among them", () => {
    // i1 to the bottom of the lane, under i3.
    drop.handleMove("w:i1", 6);
    assert.deepEqual(lane(), ["n1", "r1", "w1", "i2", "i3", "i1"]);
  });

  it("keeps a card it has just opened in place while it is selected", () => {
    r.data.selectedId = "r1";
    byId("r1").selected = true;
    byId("r1").unread = 0;
    assert.deepEqual(lane(), ["n1", "r1", "w1", "i1", "i2", "i3"]);
    // Once Jon moves on, it settles among the idle cards.
    r.data.selectedId = "i1";
    byId("r1").selected = false;
    byId("i1").selected = true;
    assert.deepEqual(lane(), ["n1", "w1", "i1", "i2", "r1", "i3"]);
  });
});
