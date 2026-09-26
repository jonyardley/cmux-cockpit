// persistSet's URL shape (docs/state-loop.md) and the default (empty) saved
// state a build with no config/state.json produces.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { installRenderer } from "./support/renderer.ts";

const r = installRenderer();
const { SAVED_STATE, persistSet } = await import("../src/shared/persist.ts");

describe("SAVED_STATE", () => {
  it("defaults to empty when no test file has seeded __STATE__", () => {
    assert.deepEqual(SAVED_STATE, { dismissed: {}, projectOverride: {} });
  });
});

describe("persistSet", () => {
  it("asks for a set, JSON-encoding and URL-encoding the value", () => {
    persistSet("dismissed.w1", { a1: 500 });
    assert.deepEqual(r.opened, [`cmux-cockpit://set?key=dismissed.w1&value=${encodeURIComponent('{"a1":500}')}`]);
  });

  it("asks for a delete when the value is null, with no value param", () => {
    r.opened.length = 0;
    persistSet("projectOverride.w1", null);
    assert.deepEqual(r.opened, ["cmux-cockpit://set?key=projectOverride.w1"]);
  });

  it("encodes characters in the key and value that need it", () => {
    r.opened.length = 0;
    persistSet("dismissed.w 1", "a b&c");
    const url = r.opened[0];
    assert.ok(url);
    assert.equal(
      url,
      `cmux-cockpit://set?key=${encodeURIComponent("dismissed.w 1")}&value=${encodeURIComponent('"a b&c"')}`,
    );
    // The raw space and ampersand must not survive unencoded.
    assert.doesNotMatch(url, /dismissed\.w 1/);
    assert.doesNotMatch(url, /value="a b&c"/);
  });
});
