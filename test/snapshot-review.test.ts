// Scene: the For review lane with a card for each merge verdict, and its
// header's "N ready to merge", under a Main activity card whose PR is ready:
// it stays there until Jon moves it.
// Fixture data in test/support/scenes.ts, shared with its golden test;
// see test/support/snapshot.ts.

import { it } from "node:test";
import { SCENES } from "./support/scenes.ts";
import { seed, snapshotScene } from "./support/snapshot.ts";

const scene = SCENES["review-verdicts"];
const r = seed(scene.seed());
await import("../src/cockpit/index.ts");
const { C } = await import("../src/cockpit/theme.ts");

it("for review: merge verdicts", () => {
  scene.data(r);
  snapshotScene("review-verdicts", r, C, "cockpit");
});
