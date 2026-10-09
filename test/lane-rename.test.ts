// A lane renamed in lanes.json renames its cmux group (issue #294).
// __LANES__ and __STATE__ are set before the renderer import, as the build
// bakes them in: main renamed from its built-in name, review unchanged, a
// saved lane renamed onto a group that already exists, Background renamed
// with no group under either name, and a new lane the build never recorded.

import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { emptyState } from "../scripts/state-config.ts";
import { resolveLanes } from "../src/cockpit/lane-config.ts";

const table = resolveLanes([
  { id: "main", name: "Doing" },
  { id: "review", name: "For review" },
  { id: "ideas", name: "Thoughts" },
  { id: "bg", name: "Later" },
  { name: "Shelf" },
]);
assert.ok(table.ok);
const g = globalThis as Record<string, unknown>;
g.__LANES__ = table.lanes;
g.__STATE__ = { ...emptyState(), laneNames: { ideas: "Ideas" } };

const { installRenderer } = await import("./support/renderer.ts");
const r = installRenderer();
const { group, ws } = await import("./support/fixtures.ts");
const { allWorkspaces } = await import("../src/cockpit/model.ts");

const writes = (): string[] => r.opened.map((u) => decodeURIComponent(u.replace(/^cmux-cockpit:\/\/set\?/, "")));

beforeEach(() => {
  r.data.groups = [
    group("g-main", "Main activity", { anchorId: "anchor-main" }),
    group("g-review", "For review", { anchorId: "anchor-review" }),
    group("g-ideas", "Ideas"),
    group("g-thoughts", "Thoughts"),
    group("g-shelf", "Shelf"),
  ];
  r.data.workspaces = [
    ws("anchor-main", { title: "Main activity", group: "g-main" }),
    ws("anchor-review", { title: "For review", group: "g-review" }),
  ];
});

describe("renaming a lane in lanes.json", () => {
  it("waits for cmux's groups before acting", () => {
    // Holds: renderer.d.ts lets data.groups() return undefined before cmux
    // sends any; only the fake's own type is narrower.
    r.data.groups = undefined as unknown as WorkspaceGroup[];
    allWorkspaces();
    r.data.groups = [];
    allWorkspaces();
    assert.deepEqual(r.calls, []);
    assert.deepEqual(r.opened, []);
  });

  it("renames a renamed lane's group and anchor, and saves each changed name once", () => {
    allWorkspaces();
    assert.deepEqual(r.calls, [
      { method: "workspace.group.rename", params: { group_id: "g-main", name: "Doing" } },
      { method: "workspace.rename", params: { workspace_id: "anchor-main", title: "Doing" } },
    ]);
    // ideas: Thoughts already has a group, so neither is renamed. bg: no
    // group under either name, so it waits. review is unchanged and Shelf
    // was never recorded, so neither is written.
    assert.deepEqual(writes(), ['key=laneNames.main&value="Doing"', 'key=laneNames.ideas&value="Thoughts"']);
  });

  it("does nothing on later frames, though cmux still shows the old name", () => {
    r.calls.length = 0;
    r.opened.length = 0;
    allWorkspaces();
    allWorkspaces();
    assert.deepEqual(r.calls, []);
    assert.deepEqual(r.opened, []);
  });

  it("saves a waiting lane's name once its group turns up under it, renaming nothing", () => {
    r.calls.length = 0;
    r.opened.length = 0;
    r.data.groups.push(group("g-later", "Later"));
    allWorkspaces();
    assert.deepEqual(r.calls, []);
    assert.deepEqual(writes(), ['key=laneNames.bg&value="Later"']);
  });
});
