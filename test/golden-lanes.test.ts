// Golden JSON for the lanes scene: what the cockpit model computes from it,
// for the native core to match. See test/support/golden.ts.

import { it } from "node:test";
import { goldenScene } from "./support/golden.ts";
import { SCENES } from "./support/scenes.ts";
import { seed } from "./support/snapshot.ts";

const scene = SCENES.lanes;
const r = seed(scene.seed);
await import("../src/cockpit/index.ts");

it("lanes: the model's answers match test/golden/", async () => {
  scene.data(r);
  await goldenScene("lanes", r);
});
