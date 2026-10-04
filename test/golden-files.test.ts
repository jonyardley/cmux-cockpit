// Every file in test/golden/ belongs to a scene some golden test still
// records, so a renamed or dropped scene cannot leave a stale file behind
// that nothing checks. README.md is the contract, not a scene.

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { it } from "node:test";

it("has no golden file without its scene", () => {
  const sources = readdirSync("test")
    .filter((f) => /^golden-.*\.test\.ts$/.test(f))
    .map((f) => readFileSync(`test/${f}`, "utf8"))
    .join("\n");
  const scenes = new Set([...sources.matchAll(/goldenScene\("([^"]+)"/g)].map((m) => m[1]));
  const orphans = readdirSync("test/golden").filter(
    (f) => f !== "README.md" && !scenes.has(f.replace(/(\.input)?\.json$/, "")),
  );
  assert.deepEqual(orphans, [], "delete these, or restore their scene");
});
