// Scene: the Projects view, with cards grouped under two projects, one card
// outside any project, one card quoting its saved move, a merged card,
// dimmed, and the third project folded into the quiet list.
// Fixture data in test/support/scenes.ts, shared with its golden test;
// see test/support/snapshot.ts.

import { it } from "node:test";
import { SCENES } from "./support/scenes.ts";
import { seed, snapshotScene } from "./support/snapshot.ts";

const scene = SCENES.projects;
const r = seed(scene.seed());
await import("../src/cockpit/index.ts");
const { C } = await import("../src/cockpit/theme.ts");

it("the projects view", () => {
  scene.data(r);
  snapshotScene("projects", r, C, "cockpit");
});
