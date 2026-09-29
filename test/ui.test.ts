// The shared view builders (src/shared/ui.ts, issue #82). The fake renderer
// draws nothing, but it reads every reactive argument, so these check that
// each builder reads what it is handed, plus the one pure decision.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { installRenderer, recordModifiers } from "./support/renderer.ts";

const r = installRenderer();
const ui = await import("../src/shared/ui.ts");
const { NEUTRAL_CHIP, prChipColors } = await import("../src/shared/pr-colors.ts");
const { P } = await import("../src/shared/palette.ts");
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
    ui.ring(Text("x"), "#FFFFFF", "#000000", 1, 6, { hug: true });
  });

  it("ring frames the full width before painting the face, unless it hugs (issue #93)", () => {
    const orderOf = (hug: boolean): string[] =>
      recordModifiers(() => ui.ring(Text("x"), "#FFFFFF", "#000000", 1, 6, { hug })).filter(
        (m) => m === "frame" || m === "background",
      );
    // The face, then the edge: filling the row means a frame comes first.
    assert.deepEqual(orderOf(false), ["frame", "background", "background"]);
    assert.deepEqual(orderOf(true), ["background", "background"]);
  });

  it("ring puts a hover on the face, and on the edge only when given one", () => {
    const hovers = (hover?: { face: string; edge?: string }): number =>
      recordModifiers(() =>
        ui.ring(Text("x"), "#FFFFFF", "#000000", 1, 6, { hug: true, ...(hover ? { hover } : {}) }),
      ).filter((m) => m === "hoverBackground").length;
    assert.equal(hovers(), 0);
    assert.equal(hovers({ face: "#EEEEEE" }), 1);
    assert.equal(hovers({ face: "#EEEEEE", edge: "#999999" }), 2);
  });

  it("chipHover darkens the chip's own face and edge, so a state colour survives", () => {
    const hover = ui.chipHover(() => NEUTRAL_CHIP);
    const face = typeof hover.face === "function" ? hover.face() : hover.face;
    const edge = typeof hover.edge === "function" ? hover.edge() : hover.edge;
    assert.notEqual(face, NEUTRAL_CHIP.bg);
    assert.notEqual(edge, NEUTRAL_CHIP.edge);
    assert.match(face, /^#[0-9A-F]{6}$/);
  });

  it("chipHover keeps a chip's resting colours while it has nothing to open", () => {
    const read = (v: Reactive<string> | undefined): string | undefined => (typeof v === "function" ? v() : v);
    const hover = ui.chipHover(
      () => NEUTRAL_CHIP,
      () => false,
    );
    assert.equal(read(hover.face), NEUTRAL_CHIP.bg);
    assert.equal(read(hover.edge), NEUTRAL_CHIP.edge);
  });

  it("chipHover gives a PR's words a link's box, since a clear face has nothing to darken", () => {
    const read = (v: Reactive<string> | undefined): string | undefined => (typeof v === "function" ? v() : v);
    const words = prChipColors("ready");
    assert.equal(read(ui.chipHover(() => words).face), P.linkHover);
    assert.equal(read(ui.chipHover(() => words).edge), P.linkEdge);
    const idle = ui.chipHover(
      () => words,
      () => false,
    );
    assert.equal(read(idle.face), "clear");
    assert.equal(read(idle.edge), "clear");
  });

  it("openIfUrl opens a url and ignores a missing one", () => {
    const before = r.opened.length;
    ui.openIfUrl(undefined);
    ui.openIfUrl("");
    ui.openIfUrl("https://example.com");
    assert.deepEqual(r.opened.slice(before), ["https://example.com"]);
  });

  it("tapChip and linkBox hover, tap, and show the browser mark only on hover", () => {
    const label = spy("open");
    const chipMods = recordModifiers(() =>
      ui.tapChip(
        label.get,
        () => NEUTRAL_CHIP,
        () => undefined,
      ),
    );
    assert.ok(label.reads() > 0);
    assert.ok(chipMods.includes("hoverBackground") && chipMods.includes("onTap"));
    const linkMods = recordModifiers(() => ui.linkBox([Text("#12")], "#000000", () => "https://example.com/pr/12"));
    assert.ok(linkMods.includes("showOnHover") && linkMods.includes("onTap"));
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
    assert.ok(ui.sectionTitle("PULL REQUESTS", "#000000"));
  });

  it("reads a section heading's label live when given a function", () => {
    const label = spy("THIS WORKSPACE · Cockpit");
    ui.sectionTitle(label.get, "#000000");
    assert.ok(label.reads() > 0);
  });
});
