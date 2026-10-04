// Every scene in scenes.ts has its golden test and files, and every file in
// test/golden/ belongs to one, so a scene added without a golden test, or a
// renamed or dropped one, fails here. README.md is the contract, and a
// dotfile (Finder's .DS_Store) is no scene's.

import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { it } from "node:test";
import { SCENES } from "./support/scenes.ts";

const names = Object.keys(SCENES);

it("has a golden test for every scene", () => {
  const missing = names.filter((n) => {
    const file = `test/golden-${n}.test.ts`;
    return !existsSync(file) || !readFileSync(file, "utf8").includes(`goldenTest("${n}")`);
  });
  assert.deepEqual(missing, [], "add test/golden-<scene>.test.ts calling goldenTest for these");
});

it("has no golden file without its scene", () => {
  const recorded = new Set(names.flatMap((n) => [`${n}.json`, `${n}.input.json`]));
  const orphans = readdirSync("test/golden").filter((f) => !f.startsWith(".") && f !== "README.md" && !recorded.has(f));
  assert.deepEqual(orphans, [], "delete these, or restore their scene");
});
