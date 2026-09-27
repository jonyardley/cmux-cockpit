// A project made in the sidebar (issue #9) after the build merged it: it is
// in both __PROJECTS__ and __STATE__.projects, and only it can be restyled
// or removed from the card menu. Seeded before the renderer is imported; see
// test/support/renderer.ts.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { beforeEach, describe, it } from "node:test";

const spec = { name: "Scratch", color: "#6A9BCC", icon: "folder.fill", root: "/Users/jon/dev/scratch" };
const key = "/users/jon/dev/scratch";
const g = globalThis as Record<string, unknown>;
g.__PROJECTS__ = [...JSON.parse(readFileSync("config/projects.example.json", "utf8")), { match: key, ...spec }];
g.__STATE__ = { dismissed: {}, projectOverride: {}, projects: { [key]: spec } };

const { installRenderer } = await import("./support/renderer.ts");
const r = installRenderer();
const { ws } = await import("./support/fixtures.ts");
const model = await import("../src/cockpit/model.ts");
const { cardMenu } = await import("../src/cockpit/views/parts.ts");
const { PROJECT_COLORS, PROJECT_ICONS } = await import("../src/shared/projects.ts");

const card = ws("w1", { directory: "/Users/jon/dev/scratch/src" });
const sent = () => r.opened.map((u) => new URL(u).searchParams.get("value")).map((v) => (v ? JSON.parse(v) : null));

describe("a sidebar-made project on the card menu", () => {
  beforeEach(() => {
    r.data.workspaces = [card];
    r.opened.length = 0;
  });

  it("names the project on its items, and offers no new one", () => {
    r.menu.length = 0;
    cardMenu(() => card);
    for (const item of ["Next colour: Scratch", "Next icon: Scratch", "Remove project: Scratch"]) {
      assert.ok(r.menu.includes("button:" + item), item);
    }
    assert.equal(model.canCreateProject(card), false);
  });

  it("steps colour and icon on from the last one sent, before the rebuild lands", () => {
    model.cycleProjectColor(card);
    model.cycleProjectColor(card);
    model.cycleProjectIcon(card);
    const [c1, c2, i1] = sent();
    assert.equal(c1.color, PROJECT_COLORS[2]);
    assert.equal(c2.color, PROJECT_COLORS[3]);
    assert.deepEqual(i1, { ...spec, color: PROJECT_COLORS[3], icon: PROJECT_ICONS[1] });
  });

  it("removes it with a delete, then offers nothing more for it", () => {
    model.removeProject(card);
    assert.deepEqual(r.opened, [`cmux-cockpit://set?key=${encodeURIComponent("projects." + key)}`]);
    assert.equal(model.inAppProjectName(card), null);
    model.cycleProjectColor(card);
    model.removeProject(card);
    assert.equal(r.opened.length, 1);
  });
});
