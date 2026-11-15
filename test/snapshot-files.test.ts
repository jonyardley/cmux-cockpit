// Every file in test/__snapshots__/ belongs to a scene some snapshot test
// still records, so a renamed or dropped scene cannot leave a stale file
// behind that nothing checks.

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { it } from "node:test";

it("has no snapshot file without its scene", () => {
  const sources = readdirSync("test")
    .filter((f) => /^snapshot-.*\.test\.ts$/.test(f))
    .map((f) => readFileSync(`test/${f}`, "utf8"))
    .join("\n");
  const scenes = new Set([...sources.matchAll(/snapshotScene\("([^"]+)"/g)].map((m) => m[1]));
  const orphans = readdirSync("test/__snapshots__").filter((f) => !scenes.has(f.replace(/\.txt$/, "")));
  assert.deepEqual(orphans, [], "delete these, or restore their scene");
});
