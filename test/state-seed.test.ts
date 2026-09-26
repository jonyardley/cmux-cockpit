// Seeding from a saved state (issues #5 and #8): a dismissal or a project
// override made before the last reload must still hold at the next one.
// __STATE__ has to be set before support/renderer.ts is (dynamically)
// imported, since that import is what installs the default; see
// test/support/renderer.ts.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

(globalThis as Record<string, unknown>).__STATE__ = {
  dismissed: { w1: { a1: 500 } },
  // w3 is not a project in config/projects.example.json: seeding must drop it.
  projectOverride: { w2: "/dev/app-one", w3: "not-a-project" },
};

const { installRenderer } = await import("./support/renderer.ts");
const r = installRenderer();
const { agent, ws } = await import("./support/fixtures.ts");
const needs = await import("../src/shared/needs.ts");
const model = await import("../src/cockpit/model.ts");

describe("needs.ts seeds dismissed from the saved state (issue #5)", () => {
  it("shows the saved dismissal's agent as idle, and only that exact spell", () => {
    // First agent() call in this file, so it gets id "a1" to match the seed.
    const asker = agent("needs_input", { sinceEpoch: 500 });
    const w = ws("w1", { agents: [asker] });
    assert.equal(needs.isNeedsDismissed(w), true);
    assert.equal(needs.agentsOf(w)[0]?.status, "idle");

    w.agents = [{ ...asker, sinceEpoch: 900 }];
    assert.equal(needs.isNeedsDismissed(w), false);
  });
});

describe("model.ts seeds projectOverride from the saved state (issue #8)", () => {
  it("keeps a saved override for a configured project", () => {
    assert.equal(model.hasProjectOverride(ws("w2")), true);
    assert.equal(model.projectKey(ws("w2", { directory: "/Users/coder/dev/app-two" })), "/dev/app-one");
  });

  it("drops a saved override that no longer names a configured project", () => {
    assert.equal(model.hasProjectOverride(ws("w3")), false);
  });

  it("keeps the seeded override through an empty or partial workspace list at startup", () => {
    r.data.workspaces = [];
    model.cardWorkspaces(); // triggers pruneProjectOverride; must not touch a seeded entry
    assert.equal(model.hasProjectOverride(ws("w2")), true);

    r.data.workspaces = [ws("other")]; // partial: w2 still not reported yet
    model.cardWorkspaces();
    assert.equal(model.hasProjectOverride(ws("w2")), true);

    r.data.workspaces = [ws("w2", { directory: "/Users/coder/dev/app-two" }), ws("other")];
    const w2 = r.data.workspaces[0];
    assert.ok(w2);
    assert.equal(model.projectKey(w2), "/dev/app-one");
  });
});
