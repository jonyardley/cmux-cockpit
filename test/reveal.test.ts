// Tapping a Needs you row or Next unfolds what hides the card, so the
// selection lands somewhere Jon can see it.

import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { installRenderer } from "./support/renderer.ts";

const r = installRenderer();
const { agent, group, ws } = await import("./support/fixtures.ts");
const model = await import("../src/cockpit/model.ts");
const state = await import("../src/cockpit/state.ts");
const { laneByKey } = await import("../src/cockpit/lanes.ts");

const asking = () => [agent("needs_input", { sinceEpoch: r.data.epoch - 30 })];

function setup(): void {
  r.data.epoch += 100;
  r.data.selectedId = null;
  r.data.groups = [
    group("g-main", "Main activity", { anchorId: "anchor-main" }),
    group("g-parked", "Parked", { anchorId: "anchor-parked", collapsed: true }),
  ];
  r.data.workspaces = [
    ws("anchor-main", { title: "Main activity", group: "g-main" }),
    ws("a", { group: "g-main" }),
    ws("anchor-parked", { title: "Parked", group: "g-parked", agents: asking() }),
    ws("p", { group: "g-parked", agents: asking() }),
    ws("u", { agents: asking() }),
  ];
  r.calls.length = 0;
  state.setMode("all");
  state.setUnsortedCollapsed(false);
  state.setCollapsedProjects([]);
}

const byId = (id: string): Workspace => {
  const w = r.data.workspaces.find((x) => x.id === id);
  if (!w) throw new Error("fixture " + id);
  return w;
};
const methods = () => r.calls.map((c) => c.method);
const cardShown = (id: string) => model.flatEntries().some((e) => e.kind === "ws" && e.wsId === id);

describe("revealing a card from Needs you", () => {
  beforeEach(setup);

  it("unfolds a folded lane before selecting its card", () => {
    const parked = laneByKey("parked");
    assert.equal(model.isCollapsed(parked), true);
    assert.equal(cardShown("p"), false);
    model.revealWorkspace(byId("p"));
    assert.equal(model.isCollapsed(parked), false);
    assert.equal(cardShown("p"), true);
    assert.deepEqual(methods(), ["workspace.group.expand", "workspace.select"]);
  });

  it("unfolds Unsorted, which is folded locally, not in cmux", () => {
    state.setUnsortedCollapsed(true);
    model.revealWorkspace(byId("u"));
    assert.equal(state.unsortedCollapsed(), false);
    assert.equal(cardShown("u"), true);
    assert.deepEqual(methods(), ["workspace.select"]);
  });

  it("leaves an open lane alone", () => {
    model.revealWorkspace(byId("a"));
    assert.deepEqual(methods(), ["workspace.select"]);
  });

  it("only selects a lane's generated anchor: its status is on the header, folded or not", () => {
    model.revealWorkspace(byId("anchor-parked"));
    assert.deepEqual(methods(), ["workspace.select"]);
  });

  it("unfolds the card's project in Projects, and leaves the lanes alone", () => {
    state.setMode("projects");
    const k = model.projectKey(byId("p"));
    state.setCollapsedProjects([k]);
    model.revealWorkspace(byId("p"));
    assert.equal(model.isProjectCollapsed(k), false);
    // No workspace.group.expand: the lane stays as Jon left it.
    assert.deepEqual(methods(), ["workspace.select"]);
  });

  it("does the same for Next", () => {
    // Only the Unsorted card waits, so Next goes there.
    byId("p").agents = [];
    byId("anchor-parked").agents = [];
    state.setUnsortedCollapsed(true);
    model.jumpNext();
    assert.equal(state.unsortedCollapsed(), false);
    assert.deepEqual(
      r.calls.map((c) => [c.method, c.params.workspace_id]),
      [["workspace.select", "u"]],
    );
  });
});
