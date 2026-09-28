// The shared view builders (src/shared/ui.ts, issue #82). The fake renderer
// draws nothing, but it reads every reactive argument, so these check that
// each builder reads what it is handed, plus the one pure decision.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { installRenderer, recordModifiers } from "./support/renderer.ts";

installRenderer();
const ui = await import("../src/shared/ui.ts");
const { NEUTRAL_CHIP } = await import("../src/shared/pr-colors.ts");
const { PROJECTS } = await import("../src/shared/projects.ts");

// A getter that counts its reads.
function spy<T>(value: T): { get: () => T; reads: () => number } {
  let n = 0;
  return {
    get: () => {
      n++;
      return value;
    },
    reads: () => n,
  };
}

describe("badgeLabel", () => {
  it("shows the count, and nothing at zero or below", () => {
    assert.equal(ui.badgeLabel(3), "3");
    assert.equal(ui.badgeLabel(0), "");
    assert.equal(ui.badgeLabel(-1), "");
    assert.equal(ui.badgeLabel(Number.NaN), "");
  });
});

describe("the shared builders read what they are handed", () => {
  it("unreadBadge reads its count", () => {
    const n = spy(2);
    ui.unreadBadge(n.get);
    assert.ok(n.reads() > 0);
    const zero = spy(0);
    ui.unreadBadge(zero.get);
    assert.ok(zero.reads() > 0);
  });

  it("ring reads a reactive width, face and edge, and takes a plain width", () => {
    const width = spy(1.5);
    const face = spy("#FFFFFF");
    const edge = spy("#000000");
    ui.ring(Text("x"), face.get, edge.get, width.get, 9);
    assert.ok(width.reads() > 0 && face.reads() > 0 && edge.reads() > 0);
    ui.ring(Text("x"), "#FFFFFF", "#000000", 1, 6, true);
  });

  it("ring frames the full width before painting the face, unless it hugs (issue #93)", () => {
    const orderOf = (hug: boolean): string[] =>
      recordModifiers(() => ui.ring(Text("x"), "#FFFFFF", "#000000", 1, 6, hug)).filter(
        (m) => m === "frame" || m === "background",
      );
    // The face, then the edge: filling the row means a frame comes first.
    assert.deepEqual(orderOf(false), ["frame", "background", "background"]);
    assert.deepEqual(orderOf(true), ["background", "background"]);
  });

  it("chip reads its label and colours, monospaced or not", () => {
    for (const mono of [false, true]) {
      const label = spy(":3000");
      const colors = spy(NEUTRAL_CHIP);
      ui.chip(label.get, colors.get, mono);
      assert.ok(label.reads() > 0 && colors.reads() > 0);
    }
  });

  it("meta, branchText and projectBadge read their text and project", () => {
    const age = spy("3m");
    ui.meta(age.get);
    const branch = spy("feature/long-name");
    ui.branchText(branch.get, "#000000", "medium");
    const [first] = PROJECTS;
    assert.ok(first);
    const project = spy(first);
    ui.projectBadge(project.get, 18, 9);
    assert.ok(age.reads() > 0 && branch.reads() > 0 && project.reads() > 0);
  });

  it("builds both heading styles", () => {
    assert.ok(ui.laneTitle("Main", "#000000"));
    assert.ok(ui.sectionTitle("WORKING", "#000000"));
  });

  it("reads a section heading's label live when given a function", () => {
    const label = spy("THIS WORKSPACE · Cockpit");
    ui.sectionTitle(label.get, "#000000");
    assert.ok(label.reads() > 0);
  });
});
