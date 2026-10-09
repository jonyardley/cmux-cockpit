// With config/state.json unreadable every lane would look unsaved, so a
// renamed lane's group is left alone rather than renamed on a guess.

import assert from "node:assert/strict";
import { it } from "node:test";
import { resolveLanes } from "../src/cockpit/lane-config.ts";

const table = resolveLanes([{ id: "main", name: "Doing" }]);
assert.ok(table.ok);
const g = globalThis as Record<string, unknown>;
g.__LANES__ = table.lanes;
g.__STATE_UNREADABLE__ = true;

const { installRenderer } = await import("./support/renderer.ts");
const r = installRenderer();
const { group } = await import("./support/fixtures.ts");
const { allWorkspaces } = await import("../src/cockpit/model.ts");

it("renames nothing and saves nothing while the state file is unreadable", () => {
  r.data.groups = [group("g-main", "Main activity")];
  allWorkspaces();
  assert.deepEqual(r.calls, []);
  assert.deepEqual(r.opened, []);
});
