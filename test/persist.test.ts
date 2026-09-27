// persistSet's URL shape (docs/state-loop.md) and the default (empty) saved
// state a build with no config/state.json produces.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { applySet, emptyState } from "../scripts/state-config.ts";
import { installRenderer } from "./support/renderer.ts";

const r = installRenderer();
const { SAVED_STATE, persistSet } = await import("../src/shared/persist.ts");

describe("SAVED_STATE", () => {
  it("defaults to empty when no test file has seeded __STATE__", () => {
    assert.deepEqual(SAVED_STATE, { dismissed: {}, projectOverride: {}, projects: {}, prs: {} });
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

// What the handler does with the URL, minus the file: read key and value back
// out and apply them. Catches a sidebar sending something the contract refuses.
function applyOpened(url: string) {
  const q = new URL(url).searchParams;
  return applySet(emptyState(), q.get("key") ?? "", q.get("value"));
}

describe("persistSet URLs pass the contract", () => {
  const ws = "8F3C2A1E-0B6D-4E57-9A8B-1C2D3E4F5A6B";

  it("accepts a path-shaped project key", () => {
    r.opened.length = 0;
    persistSet(`projectOverride.${ws}`, "/dev/app-one");
    const result = applyOpened(r.opened[0] ?? "");
    assert.deepEqual(result.ok && result.state.projectOverride, { [ws]: "/dev/app-one" });
  });

  it("accepts a dismissal and a delete", () => {
    r.opened.length = 0;
    persistSet(`dismissed.${ws}`, { "agent/1": 500 });
    persistSet(`dismissed.${ws}`, null);
    const [set, del] = r.opened.map(applyOpened);
    assert.deepEqual(set?.ok && set.state.dismissed, { [ws]: { "agent/1": 500 } });
    assert.equal(del?.ok, true);
  });
});
