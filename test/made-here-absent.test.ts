// Made here (#52) before the published hook has ever run: a state saved
// before the `published` map existed has no such key, and the section must
// then list nothing rather than fail.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

// globalThis has no __STATE__ property in its type; the build defines it,
// and the renderer fake reads it from here, so a plain record is enough.
(globalThis as Record<string, unknown>).__STATE__ = {
  dismissed: {},
  projectOverride: {},
  projects: {},
  prs: {},
  ownPrs: {},
  subagents: {},
  ui: {},
};

const { installRenderer } = await import("./support/renderer.ts");
const r = installRenderer();
const { ws } = await import("./support/fixtures.ts");
const m = await import("../src/agents/made.ts");

describe("madeHere without saved pages", () => {
  it("is empty when the saved state has no published map", () => {
    r.data.workspaces = [ws("sel", { selected: true })];
    assert.deepEqual(m.madeHere(), []);
  });
});
