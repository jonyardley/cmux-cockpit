// faintLine (src/shared/notice.ts): the faint line both sidebars share, shown
// only while it has something to say.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { installRenderer, modValue, nodeOf, reread } from "./support/renderer.ts";

installRenderer();
const { faintLine } = await import("../src/shared/notice.ts");

describe("faintLine", () => {
  it("draws its text small, faint and inset, up to two lines, filling the row from the leading edge", () => {
    const list = nodeOf(faintLine("note", () => "State file unreadable", "#888888", 14));
    assert.equal(list?.kind, "ForEach");
    assert.equal(list?.children.length, 1);
    const line = list?.children[0];
    assert.equal(line?.kind, "Text");
    assert.deepEqual(line?.args, ["State file unreadable"]);
    assert.equal(modValue(line, "font"), 11);
    assert.equal(modValue(line, "color"), "#888888");
    assert.equal(modValue(line, "lineLimit"), 2);
    assert.equal(modValue(line, "paddingHorizontal"), 14);
    assert.deepEqual(modValue(line, "frame"), { maxWidth: "infinity", alignment: "leading" });
  });

  it("draws nothing at all while its text is empty, so it costs no gap", () => {
    const list = nodeOf(faintLine("note", () => "", "#888888", 14));
    assert.equal(list?.kind, "ForEach");
    assert.equal(list?.children.length, 0);
  });

  it("follows its text after it is built: appears when the text fills in, says the new words, and goes when it empties", () => {
    let text = "";
    const list = nodeOf(faintLine("note", () => text, "#888888", 4));
    const items = list?.handlers.items;
    assert.equal(typeof items, "function");
    const shown = items as () => unknown[]; // checked to be a function on the line above
    assert.equal(list?.children.length, 0);
    assert.equal(shown().length, 0);
    text = "Two agents asking";
    assert.equal(shown().length, 1);
    text = "";
    assert.equal(shown().length, 0);
  });

  it("reads its words live, so a shown line changes with them", () => {
    let text = "State file unreadable";
    const line = nodeOf(faintLine("note", () => text, "#888888", 4))?.children[0];
    const words = reread(line?.rawArgs?.[0]);
    assert.equal(words(), "State file unreadable");
    text = "State file kept aside";
    assert.equal(words(), "State file kept aside");
  });
});
