import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { installRenderer } from "./support/renderer.ts";

installRenderer();
const { ws } = await import("./support/fixtures.ts");
const { isGeneratedAnchor, placeholderIds } = await import("../src/shared/anchors.ts");

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
  it("names only the generated anchors present", () => {
    const workspaces = [ws("p", { title: "Parked" }), ws("r", { title: "Chat" })];
    const groups = [
      { id: "g1", name: "Parked", anchorId: "p" },
      { id: "g2", name: "For review", anchorId: "r" },
      { id: "g3", name: "Background", anchorId: "gone" },
      { id: "g4", name: "Unanchored" },
    ];
    assert.deepEqual([...placeholderIds(groups, workspaces)], ["p"]);
  });
});
