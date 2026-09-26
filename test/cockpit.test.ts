import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { installRenderer } from "./support/renderer.ts";

const r = installRenderer();
const { agent, group, ws } = await import("./support/fixtures.ts");
const model = await import("../src/cockpit/model.ts");
const drop = await import("../src/cockpit/drop.ts");
const state = await import("../src/cockpit/state.ts");
const status = await import("../src/cockpit/status.ts");
const { LANES, laneByKey } = await import("../src/cockpit/lanes.ts");
const { chipsFor } = await import("../src/cockpit/views/parts.ts");

// Groups mirror cmux: each lane group has a generated anchor workspace.
// Each test starts later than the last, so earlier optimistic overrides expire.
function setup(): void {
  r.data.epoch += 100;
  r.data.selectedId = null;
  r.data.groups = [
    group("g-main", "Main activity", { anchorId: "anchor-main" }),
    group("g-review", "For review", { anchorId: "anchor-review" }),
    group("g-parked", "Parked", { anchorId: "anchor-parked" }),
  ];
  r.data.workspaces = [
    ws("anchor-main", { group: "g-main" }),
    ws("a", { group: "g-main" }),
    ws("b", { group: "g-main" }),
    ws("anchor-review", { group: "g-review" }),
    ws("c", { group: "g-review" }),
    ws("anchor-parked", { group: "g-parked" }),
    ws("p", { group: "g-parked" }),
    ws("u"),
  ];
  r.calls.length = 0;
  state.setMode("all");
  state.setCollapsedProjects([]);
}

const ids = () => model.flatEntries().map((e) => e.id);
const byId = (id: string) => r.data.workspaces.find((w) => w.id === id);

describe("lanes", () => {
  beforeEach(setup);

  it("maps groups to lanes by name, and ungrouped to Unsorted", () => {
    assert.equal(model.actualLaneOf(byId("a")), "main");
    assert.equal(model.actualLaneOf(byId("c")), "review");
    assert.equal(model.actualLaneOf(byId("u")), "unsorted");
    assert.equal(model.actualLaneOf(ws("x", { group: "unknown" })), "unsorted");
  });

  it("hides lane anchors from the cards", () => {
    assert.deepEqual(
      model.cardWorkspaces().map((w) => w.id),
      ["a", "b", "c", "p", "u"],
    );
  });

  it("lists every header, with Parked collapsed until touched", () => {
    assert.deepEqual(ids(), [
      "h:main",
      "a@main",
      "b@main",
      "h:review",
      "c@review",
      "h:bg",
      "h:parked",
      "h:unsorted",
      "u@unsorted",
    ]);
  });

  it("is empty outside All mode, so no drag resolves there", () => {
    state.setMode("projects");
    assert.deepEqual(model.flatEntries(), []);
  });

  it("laneByKey falls back to Unsorted and LANES ends with it", () => {
    assert.equal(LANES.at(-1)?.key, "unsorted");
    assert.equal(laneByKey("bg").name, "Background");
  });
});

describe("resolveDrop", () => {
  beforeEach(setup);

  it("takes the lane of the row above the slot", () => {
    // Without a@main: [h:main, b@main, h:review, c@review, ...]; slot 3 is under h:review.
    assert.deepEqual(drop.resolveDrop("a@main", 3), { laneKey: "review", nextRef: "c", prevRef: null });
  });

  it("files a drop at the very top into the first lane", () => {
    assert.deepEqual(drop.resolveDrop("c@review", 0), { laneKey: "main", nextRef: null, prevRef: null });
  });

  it("ignores a next card that belongs to another lane", () => {
    // Without c@review: slot 4 sits after h:review, before h:bg.
    const t = drop.resolveDrop("c@review", 4);
    assert.equal(t.laneKey, "review");
    assert.equal(t.nextRef, null);
  });
});

describe("handleMove", () => {
  beforeEach(setup);

  it("reorders before joining the new group", () => {
    drop.handleMove("a@main", 4); // after c@review
    assert.deepEqual(
      r.calls.map((c) => c.method),
      ["workspace.reorder", "workspace.group.add"],
    );
    assert.deepEqual(r.calls[1]?.params, { group_id: "g-review", workspace_id: "a" });
    // Optimistic: the card shows in its new lane before the data catches up.
    assert.equal(model.laneOf(byId("a") ?? ws("?")), "review");
  });

  it("removes from the group when dropped into Unsorted", () => {
    const slot =
      ids()
        .filter((id) => id !== "b@main")
        .indexOf("h:unsorted") + 1;
    drop.handleMove("b@main", slot);
    assert.ok(r.calls.some((c) => c.method === "workspace.group.remove" && c.params.workspace_id === "b"));
  });

  it("only reorders within the same lane", () => {
    drop.handleMove("b@main", 1); // above a
    assert.deepEqual(
      r.calls.map((c) => c.method),
      ["workspace.reorder"],
    );
    assert.deepEqual(r.calls[0]?.params, { workspace_id: "b", index: 1 });
  });

  it("ignores headers and unknown keys", () => {
    drop.handleMove("h:main", 2);
    drop.handleMove("nope", 2);
    assert.deepEqual(r.calls, []);
  });

  it("clears the drag state", () => {
    state.setDrag({ id: "a@main", index: 1 });
    drop.handleMove("a@main", 1);
    assert.equal(state.drag(), null);
  });
});

describe("foreign anchors", () => {
  beforeEach(setup);

  it("pins an anchor of a non-lane group, not a lane anchor", () => {
    r.data.groups.push(group("g-proj", "app-one", { anchorId: "a" }));
    assert.equal(drop.isForeignAnchor("a"), true);
    assert.equal(drop.isForeignAnchor("anchor-main"), false);
  });
});

describe("needs you", () => {
  beforeEach(setup);

  it("lists waiting workspaces, longest-waiting first", () => {
    const a = byId("a");
    const c = byId("c");
    if (!a || !c) throw new Error("fixture");
    a.agents = [agent("needs_input", { sinceEpoch: 200 })];
    c.agents = [agent("needs_input", { sinceEpoch: 100 })];
    assert.deepEqual(
      model.needsList().map((w) => w.id),
      ["c", "a"],
    );
  });

  it("a dismissal holds until the agent asks again", () => {
    const a = byId("a");
    if (!a) throw new Error("fixture");
    a.agents = [agent("needs_input", { sinceEpoch: 500 })];
    status.dismissNeeds(a);
    assert.equal(status.statusOf(a), "idle");
    a.agents = [agent("needs_input", { sinceEpoch: 900 })];
    assert.equal(status.statusOf(a), "needs_input");
  });
});

describe("projects mode", () => {
  beforeEach(setup);

  it("groups by project in PROJECTS order, then Other", () => {
    const a = byId("a");
    const c = byId("c");
    if (!a || !c) throw new Error("fixture");
    a.directory = "/Users/coder/dev/app-two";
    c.directory = "/Users/coder/dev/app-one";
    state.setMode("projects");
    assert.deepEqual(
      model.projectEntries().map((e) => e.id),
      ["p:/dev/app-one", "c@p", "p:/dev/app-two", "a@p", "p:other", "b@p", "p@p", "u@p"],
    );
  });

  it("keeps a project with several matches in one group, keyed by its first match", () => {
    const a = byId("a");
    const b = byId("b");
    if (!a || !b) throw new Error("fixture");
    a.directory = "/Users/coder/dev/app-two/src";
    b.directory = "/Users/coder/.config/app-two";
    state.setMode("projects");
    const ids = model.projectEntries().map((e) => e.id);
    assert.deepEqual(ids.slice(0, 3), ["p:/dev/app-two", "a@p", "b@p"]);
    assert.equal(ids.filter((id) => id.startsWith("p:") && id !== "p:other").length, 1);
    assert.equal(model.projectCount("/dev/app-two"), 2);
    assert.equal(model.projectByKey("/dev/app-two").name, "App Two");
  });

  it("collapses a multi-match project as one group", () => {
    const a = byId("a");
    const b = byId("b");
    if (!a || !b) throw new Error("fixture");
    a.directory = "/Users/coder/dev/app-two";
    b.directory = "/Users/coder/.config/app-two";
    state.setMode("projects");
    model.toggleProject("/dev/app-two");
    const ids = model.projectEntries().map((e) => e.id);
    assert.deepEqual(ids.slice(0, 2), ["p:/dev/app-two", "p:other"]);
  });
});

describe("chips", () => {
  it("shows the PR, then the branch with a dirty marker", () => {
    const chips = chipsFor(
      ws("x", { pr: { number: 7, status: "open", url: "https://x/7" }, branch: "feat", dirty: true }),
      true,
    );
    assert.deepEqual(
      chips.map((c) => c.text),
      ["#7 open", "feat •"],
    );
    assert.equal(chipsFor(ws("y", { branch: "feat" }), false).length, 0);
  });
});
