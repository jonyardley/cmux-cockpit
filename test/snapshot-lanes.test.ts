// Scene: the cockpit's lanes with a card in every state, each lane at its
// own density, a merged card in Main activity and in Unsorted, a working
// card under the folded Parked header, and one waiting on a background
// shell.
// Fixture data in test/support/scenes.ts, shared with its golden test;
// see test/support/snapshot.ts.

import { it } from "node:test";
import { SCENES } from "./support/scenes.ts";
import { seed, snapshotScene } from "./support/snapshot.ts";

const scene = SCENES.lanes;
const r = seed(scene.seed());
await import("../src/cockpit/index.ts");
const { C } = await import("../src/cockpit/theme.ts");

it("lanes: every card state", () => {
  scene.data(r);
  snapshotScene("lanes", r, C, "cockpit");
});
