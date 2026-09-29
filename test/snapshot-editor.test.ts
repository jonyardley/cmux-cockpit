// Scene: the Projects view with a projects.json project's editor open under
// its header, its name retyped. Fixture data only; see test/support/snapshot.ts.

import { it } from "node:test";
import { seed, snapshotScene } from "./support/snapshot.ts";

const r = seed({ state: { ui: { mode: "projects" } } });
const { ws } = await import("./support/fixtures.ts");
await import("../src/cockpit/index.ts");
const edit = await import("../src/cockpit/edit.ts");
const { C } = await import("../src/cockpit/theme.ts");

it("the project editor", () => {
  r.data.workspaces = [
    ws("one", { title: "One: parser", directory: "/Users/jon/dev/app-one" }),
    ws("two", { title: "Two: release", directory: "/Users/jon/dev/app-two" }),
  ];
  edit.openEditor("/dev/app-one");
  edit.setDraftName("");
  snapshotScene("editor", r, C);
});
