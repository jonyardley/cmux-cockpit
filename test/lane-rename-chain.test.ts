// A chain of lane renames: main takes review's old name while review
// becomes "To check". Review's group moves first, then main's follows,
// so neither lane loses its cards. A swap renames nothing.

import assert from "node:assert/strict";
import { it } from "node:test";
import { resolveLanes } from "../src/cockpit/lane-config.ts";

const table = resolveLanes([
  { id: "main", name: "For review" },
  { id: "review", name: "To check" },
  { id: "bg", name: "Parked" },
  { id: "parked", name: "Background" },
]);
assert.ok(table.ok);
(globalThis as Record<string, unknown>).__LANES__ = table.lanes;

const { installRenderer } = await import("./support/renderer.ts");
const r = installRenderer();
const { group } = await import("./support/fixtures.ts");
const { allWorkspaces } = await import("../src/cockpit/model.ts");

const renames = (): unknown[] => r.calls.map((c) => c.params);

it("renames review's group before main takes its old name, and never a swapped pair", () => {
  r.data.groups = [
    group("g-main", "Main activity"),
    group("g-review", "For review"),
    group("g-bg", "Background"),
    group("g-parked", "Parked"),
  ];
  allWorkspaces();
  assert.deepEqual(renames(), [{ group_id: "g-review", name: "To check" }]);
  r.calls.length = 0;
  r.data.groups = [
    group("g-main", "Main activity"),
    group("g-review", "To check"),
    group("g-bg", "Background"),
    group("g-parked", "Parked"),
  ];
  allWorkspaces();
  assert.deepEqual(renames(), [{ group_id: "g-main", name: "For review" }]);
});
