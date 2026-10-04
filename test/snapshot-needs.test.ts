// Scene: the Next button and the Needs you strip, capped at four rows with
// "+N more", one of them asking and two quoting their saved move.
// Fixture data in test/support/scenes.ts, shared with its golden test;
// see test/support/snapshot.ts.

import { it } from "node:test";
import { SCENES } from "./support/scenes.ts";
import { seed, snapshotScene } from "./support/snapshot.ts";

const scene = SCENES["needs-and-next"];
const r = seed(scene.seed());
await import("../src/cockpit/index.ts");
const { C } = await import("../src/cockpit/theme.ts");

it("needs you and next", () => {
  scene.data(r);
  snapshotScene("needs-and-next", r, C, "cockpit");
});
