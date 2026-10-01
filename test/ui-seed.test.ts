// Seeding the cockpit's view and folds from the saved state: every rebuild
// reloads the sidebar, and it must come back as it was left. __STATE__ is set
// before support/renderer.ts is imported; see test/state-seed.test.ts.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

(globalThis as Record<string, unknown>).__STATE__ = {
  dismissed: {},
  projectOverride: {},
  projects: {},
  prs: {},
  subagents: {},
  ui: { mode: "projects", collapsed: { "lane:unsorted": 1, "lane:parked": 0, "project:/dev/app-two": 1 } },
};

const { installRenderer } = await import("./support/renderer.ts");
const r = installRenderer();
const { group } = await import("./support/fixtures.ts");
const state = await import("../src/cockpit/state.ts");
const model = { ...(await import("../src/cockpit/model.ts")), ...(await import("../src/cockpit/by-project.ts")) };
const { laneByKey } = await import("../src/cockpit/lanes.ts");

describe("state.ts and model.ts seed the view and folds from the saved state", () => {
  it("opens on the saved view", () => {
    assert.equal(state.mode(), "projects");
  });

  it("keeps Unsorted and a project folded", () => {
    assert.equal(model.isCollapsed(laneByKey("unsorted")), true);
    assert.equal(model.isProjectCollapsed("/dev/app-two"), true);
    assert.equal(model.isProjectCollapsed("/dev/app-one"), false);
  });

  it("leaves a touched Parked lane to cmux's own fold rather than starting it folded", () => {
    r.data.groups = [group("g-parked", "Parked", { collapsed: false })];
    assert.equal(model.isCollapsed(laneByKey("parked")), false);
  });
});
