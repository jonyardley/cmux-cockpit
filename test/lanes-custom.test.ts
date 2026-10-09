// The cockpit on a lanes.json of its own: a new first lane, Main activity,
// Parked renamed Shelf, and a faint lane. __LANES__ and __STATE__ are set
// before the renderer import, as the build bakes them in.

import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { emptyState } from "../scripts/state-config.ts";
import { resolveLanes } from "../src/cockpit/lane-config.ts";

const table = resolveLanes([
  { name: "Ideas", color: "laneReview", leftOff: true },
  { id: "main", name: "Main activity" },
  { id: "parked", name: "Shelf" },
  { name: "Quiet", color: "laneRose", density: "row", faint: true },
]);
assert.ok(table.ok);
const g = globalThis as Record<string, unknown>;
g.__LANES__ = table.lanes;
// A fold saved while Background was still a lane.
g.__STATE__ = { ...emptyState(), ui: { collapsed: { "lane:bg": 1 } } };

const { installRenderer } = await import("./support/renderer.ts");
const r = installRenderer();
const { group, ws } = await import("./support/fixtures.ts");
const model = {
  ...(await import("../src/cockpit/model.ts")),
  ...(await import("../src/cockpit/lane-entries.ts")),
  ...(await import("../src/cockpit/by-project.ts")),
};
const { FIRST_LANE, findLane, LANES, laneByKey } = await import("../src/cockpit/lanes.ts");
const { C } = await import("../src/cockpit/theme.ts");
const { READY_INK } = await import("../src/shared/pr-colors.ts");

const byId = (id: string) => r.data.workspaces.find((w) => w.id === id);

beforeEach(() => {
  r.data.epoch += 100;
  r.data.groups = [
    group("g-ideas", "Ideas", { anchorId: "anchor-ideas" }),
    group("g-main", "Main activity", { anchorId: "anchor-main" }),
    group("g-shelf", "Shelf", { anchorId: "anchor-shelf" }),
    group("g-quiet", "Quiet"),
  ];
  r.data.workspaces = [
    ws("anchor-ideas", { title: "Ideas", group: "g-ideas" }),
    ws("i", { group: "g-ideas", directory: "/Users/coder/dev/app-one" }),
    ws("anchor-main", { title: "Main activity", group: "g-main" }),
    ws("m", { group: "g-main" }),
    ws("anchor-shelf", { title: "Shelf", group: "g-shelf" }),
    ws("s", { group: "g-shelf" }),
    ws("q", { group: "g-quiet" }),
  ];
  r.calls.length = 0;
  r.opened.length = 0;
});

describe("lanes from lanes.json", () => {
  it("lists the file's lanes in order, then Unsorted", () => {
    assert.deepEqual(
      LANES.map((l) => [l.key, l.name]),
      [
        ["Ideas", "Ideas"],
        ["main", "Main activity"],
        ["parked", "Shelf"],
        ["Quiet", "Quiet"],
        ["unsorted", "Unsorted"],
      ],
    );
    assert.equal(FIRST_LANE, "Ideas");
    assert.equal(laneByKey("Ideas").color, C.laneReview);
    assert.equal(laneByKey("Quiet").color, C.laneRose, "a hue takes its colour from the theme");
    assert.equal(findLane("bg"), undefined);
  });

  it("places cards by group name under the file's ids", () => {
    assert.equal(model.laneOf(byId("i") ?? ws("x")), "Ideas");
    assert.equal(model.laneOf(byId("s") ?? ws("x")), "parked");
    assert.equal(model.cardDensity(byId("s")), "row");
  });

  it("says where you left off only in a leftOff lane", () => {
    assert.equal(model.showsLeftOff(byId("i")), true);
    assert.equal(model.showsLeftOff(byId("s")), true);
    assert.equal(model.showsLeftOff(byId("m")), false);
    assert.equal(model.showsLeftOff(byId("q")), false);
  });

  it("draws a faint lane's merge line faint, and the others in Ready's green", () => {
    assert.equal(model.headerHint("Quiet", false).color, C.faint);
    assert.equal(model.headerHint("parked", false).color, C.faint);
    assert.equal(model.headerHint("main", false).color, READY_INK);
  });

  it("starts a renamed Parked folded", () => {
    assert.equal(model.isCollapsed(laneByKey("parked")), true);
    assert.equal(model.isCollapsed(laneByKey("Ideas")), false);
  });

  it("opens a new session in the first lane", () => {
    model.newSessionFor(byId("i"));
    assert.deepEqual(r.calls, [
      {
        method: "workspace.create",
        params: { cwd: "~/dev/app-one", focus: true, group_id: "g-ideas", group_placement: "top" },
      },
    ]);
  });

  it("ignores a move to a lane the table does not hold", () => {
    model.moveToLane(byId("m"), "bg");
    assert.deepEqual(r.calls, []);
    assert.equal(model.laneOf(byId("m") ?? ws("x")), "main");
  });

  it("keeps the saved fold of a lane taken out of the file", () => {
    model.toggleLane(laneByKey("Ideas"));
    const last = r.opened.at(-1);
    assert.ok(last);
    const q = new URL(last).searchParams;
    assert.equal(q.get("key"), "ui.collapsed");
    assert.deepEqual(JSON.parse(q.get("value") ?? "null"), { "lane:Ideas": 1, "lane:bg": 1 });
  });

  it("knows the file's lane names as anchors, in the agents panel too", async () => {
    const { LANE_GROUP_NAMES, placeholderIds } = await import("../src/shared/anchors.ts");
    assert.deepEqual([...LANE_GROUP_NAMES], ["Ideas", "Main activity", "Shelf", "Quiet"]);
    // With no group list, as the agents panel has, the title alone decides.
    const titled = ["Ideas", "Shelf", "Parked", "For review"].map((t) => ws(t, { title: t }));
    const ids = placeholderIds([], new Map(titled.map((w) => [w.id, w])));
    assert.deepEqual([...ids], ["Ideas", "Shelf"], "the old names are cards now");
  });
});
