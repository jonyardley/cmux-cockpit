// npm run pr-visuals: which scenes count as changed, and the table it
// prints for the PR description.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { changedScenes, markdown, pngWidth } from "../scripts/pr-visuals.ts";

const shots = (entries: [string, string][]): Map<string, Buffer> =>
  new Map(entries.map(([k, v]) => [k, Buffer.from(v)]));

describe("changedScenes", () => {
  it("keeps only scenes whose bytes differ, sorted by name", () => {
    const before = shots([
      ["lanes", "a"],
      ["agents", "b"],
      ["editor", "c"],
    ]);
    const after = shots([
      ["lanes", "a2"],
      ["agents", "b2"],
      ["editor", "c"],
    ]);
    assert.deepEqual(changedScenes(before, after), [
      { scene: "agents", before: true, after: true },
      { scene: "lanes", before: true, after: true },
    ]);
  });

  it("counts a scene new on the branch or gone from it as changed", () => {
    const before = shots([["old", "x"]]);
    const after = shots([["new", "y"]]);
    assert.deepEqual(changedScenes(before, after), [
      { scene: "new", before: false, after: true },
      { scene: "old", before: true, after: false },
    ]);
  });

  it("returns nothing when every scene matches", () => {
    assert.deepEqual(changedScenes(shots([["lanes", "a"]]), shots([["lanes", "a"]])), []);
  });
});

describe("pngWidth", () => {
  it("reads the width from the IHDR header", () => {
    const png = Buffer.alloc(24);
    png.writeUInt32BE(640, 16);
    assert.equal(pngWidth(png), 640);
  });
});

describe("markdown", () => {
  it("says so when nothing changed", () => {
    assert.equal(markdown([]), "No visual changes in the preview scenes.");
  });

  it("puts each scene's pair side by side at its point width", () => {
    const table = markdown([
      { scene: "lanes", before: { url: "b.png", width: 320 }, after: { url: "a.png", width: 330 } },
      { scene: "new", after: { url: "n.png", width: 320 } },
      { scene: "old", before: { url: "o.png", width: 320 } },
    ]);
    assert.equal(
      table,
      [
        "| Scene | Before | After |",
        "| --- | --- | --- |",
        '| lanes | <img src="b.png" width="320" alt=""> | <img src="a.png" width="330" alt=""> |',
        '| new | not on main | <img src="n.png" width="320" alt=""> |',
        '| old | <img src="o.png" width="320" alt=""> | removed on this branch |',
      ].join("\n"),
    );
  });
});
