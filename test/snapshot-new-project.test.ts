// Scene: the Projects view with "+ New project" open, a folder typed and
// one open folder on offer, and that folder's card under Other with its
// "Make project" chip. Fixture data only; see test/support/snapshot.ts.

import { it } from "node:test";
import { seed, snapshotScene } from "./support/snapshot.ts";

(globalThis as Record<string, unknown>).__HOME__ = "/Users/jon";
const r = seed({ state: { ui: { mode: "projects" } } });
const { ws } = await import("./support/fixtures.ts");
await import("../src/cockpit/index.ts");
const edit = await import("../src/cockpit/edit.ts");
const { C } = await import("../src/cockpit/theme.ts");

it("making a new project", () => {
  r.data.workspaces = [
    ws("one", { title: "One: parser", directory: "/Users/jon/dev/app-one" }),
    ws("sketch", { title: "Sketch: first pass", directory: "/Users/jon/dev/sketch" }),
  ];
  edit.openNewProject();
  edit.setDraftFolder("~/dev/pianola");
  snapshotScene("new-project", r, C, "cockpit");
});
