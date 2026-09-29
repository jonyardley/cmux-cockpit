import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { installRenderer } from "./support/renderer.ts";

installRenderer();
const { agent, ws } = await import("./support/fixtures.ts");
const { isGeneratedAnchor, LANE_GROUP_NAMES, placeholderIds } = await import("../src/shared/anchors.ts");
const { LANES } = await import("../src/cockpit/lanes.ts");

describe("isGeneratedAnchor", () => {
  it("matches an anchor titled after its group, ignoring case and spaces", () => {
    assert.equal(isGeneratedAnchor({ id: "g", name: "For review" }, ws("a", { title: " for REVIEW " })), true);
  });

  it("treats a missing anchor as the placeholder, so it never flashes up", () => {
    assert.equal(isGeneratedAnchor({ id: "g", name: "For review" }, undefined), true);
  });

  it("keeps a real workspace, and a nameless group's untitled anchor", () => {
    assert.equal(isGeneratedAnchor({ id: "g", name: "For review" }, ws("a", { title: "Chat" })), false);
    assert.equal(isGeneratedAnchor({ id: "g" }, ws("a", { title: "" })), false);
  });
});

describe("placeholderIds", () => {
  it("names only the lane groups' generated anchors present", () => {
    // Working, so only the group list marks it: the title match skips a busy one.
    const workspaces = [
      ws("p", { title: "Parked", agents: [agent("working")] }),
      ws("r", { title: "Chat" }),
      ws("mine", { title: "my group" }),
    ];
    const groups = [
      { id: "g1", name: "Parked", anchorId: "p" },
      { id: "g2", name: "For review", anchorId: "r" },
      { id: "g3", name: "Background", anchorId: "gone" },
      { id: "g4", name: "Main activity" },
      { id: "g5", name: "my group", anchorId: "mine" },
    ];
    const byId = new Map(workspaces.map((w) => [w.id, w]));
    assert.deepEqual([...placeholderIds(groups, byId)], ["p"]);
  });

  it("with no group list, names an idle workspace titled after a lane", () => {
    const workspaces = [
      ws("idle", { title: " for REVIEW ", agents: [agent("idle")] }),
      ws("none", { title: "Parked" }),
      ws("busy", { title: "Background", agents: [agent("working")] }),
      ws("asking", { title: "Main activity", agents: [agent("needs_input")] }),
      ws("chat", { title: "Some chat" }),
    ];
    const byId = new Map(workspaces.map((w) => [w.id, w]));
    assert.deepEqual([...placeholderIds([], byId)].sort(), ["idle", "none"]);
  });

  it("knows the same lane names the cockpit draws", () => {
    const named = LANES.filter((l) => l.key !== "unsorted").map((l) => l.name);
    assert.deepEqual([...LANE_GROUP_NAMES], named);
  });
});
