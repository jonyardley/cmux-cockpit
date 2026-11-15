// The agents panel on a lanes.json of its own: a new first lane, Main
// activity, Parked renamed Shelf, and a faint lane. __LANES__ is set before
// the renderer import, as the build bakes it in.

import assert from "node:assert/strict";
import { it } from "node:test";
import { resolveLanes } from "../src/shared/lane-config.ts";

const table = resolveLanes([
  { name: "Ideas", color: "laneReview", leftOff: true },
  { id: "main", name: "Main activity" },
  { id: "parked", name: "Shelf" },
  { name: "Quiet", color: "laneRose", density: "row", faint: true },
]);
assert.ok(table.ok);
(globalThis as Record<string, unknown>).__LANES__ = table.lanes;

const { installRenderer } = await import("./support/renderer.ts");
installRenderer();
const { ws } = await import("./support/fixtures.ts");
const { LANE_GROUP_NAMES, placeholderIds } = await import("../src/shared/anchors.ts");

it("knows the file's lane names as anchors", () => {
  assert.deepEqual([...LANE_GROUP_NAMES], ["Ideas", "Main activity", "Shelf", "Quiet"]);
  // With no group list, as the agents panel has, the title alone decides.
  const titled = ["Ideas", "Shelf", "Parked", "For review"].map((t) => ws(t, { title: t }));
  const ids = placeholderIds([], new Map(titled.map((w) => [w.id, w])));
  assert.deepEqual([...ids], ["Ideas", "Shelf"], "the old names are cards now");
});
