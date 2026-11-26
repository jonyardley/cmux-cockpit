// The PR list on a lanes.json of its own: a new first lane, Main activity,
// Parked renamed Shelf, and another. __LANES__ is set before the renderer
// import, as the build bakes it in.

import assert from "node:assert/strict";
import { it } from "node:test";
import { laneNames } from "../scripts/lanes-config.ts";

const table = laneNames([
  { name: "Ideas", color: "laneReview", leftOff: true },
  { id: "main", name: "Main activity" },
  { id: "parked", name: "Shelf" },
  { name: "Quiet", color: "laneRose", density: "row", faint: true },
]);
assert.ok(table.ok);
(globalThis as Record<string, unknown>).__LANES__ = table.names;

const { installRenderer } = await import("./support/renderer.ts");
const r = installRenderer();
const { ws } = await import("./support/fixtures.ts");
const m = await import("../src/agents/pr-list.ts");

it("takes the file's lane names for placeholders, and the old names for chats", () => {
  const titled = ["Ideas", "Shelf", "Parked", "For review"].map((t) => ws(t, { title: t }));
  assert.deepEqual(
    titled.filter(m.isLanePlaceholder).map((w) => w.id),
    ["Ideas", "Shelf"],
  );
});

it("leaves out the PRs cmux pins on them", () => {
  r.data.workspaces = [
    ws("shelf", { title: "Shelf", pr: { url: "u/1", number: 1, status: "open" } }),
    ws("parked", { title: "Parked", pr: { url: "u/2", number: 2, status: "open" } }),
  ];
  assert.deepEqual(
    m.prs().map((e) => e.pr.number),
    [2],
  );
});
