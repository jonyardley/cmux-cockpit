// Issue #388, first half: the native core saves the waits on Jon each
// Cockpit card shows. Its SaveWaits effect reaches scripts/waits-save.ts as
// JSON (the shape native/runner/tests/effects.json pins for the Rust
// side), which writes it in config/state.json's `waits` map for the
// agents panel to read.

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { MAX_WAITS, type SavedWait, validateState } from "../scripts/state-config.ts";
import { writeWaitEntries } from "../scripts/state-url.ts";
import { parseWaitsSave } from "../scripts/waits-save.ts";

const dir = mkdtempSync(join(tmpdir(), "waits-save-"));
after(() => rmSync(dir, { recursive: true, force: true }));
const fileIn = (name: string, state: unknown): string => {
  const path = join(dir, name);
  writeFileSync(path, JSON.stringify(state));
  return path;
};
const read = (path: string) => validateState(JSON.parse(readFileSync(path, "utf8")));

const park = (since: number): SavedWait => ({ kind: "park", since, key: since });
const stop: SavedWait = { kind: "stopped", since: 100, key: 100, agent: "s1", detail: "error" };

// The SaveWaits entry the Rust tests hold the bridge's JSON to.
const effects: unknown = JSON.parse(
  readFileSync(join(import.meta.dirname, "..", "native", "runner", "tests", "effects.json"), "utf8"),
);
const native = (Array.isArray(effects) ? effects : []).find((e) => e && typeof e === "object" && "SaveWaits" in e)
  ?.SaveWaits?.waits;

describe("the waits map's contract", () => {
  it("reads waits as persist.rs's waits_map does", () => {
    // The same sample as persist.rs's reads_waits_as_validate_state_does.
    const state = validateState({
      waits: {
        w1: [
          { ...stop, extra: 1 },
          { kind: "ci_stuck", since: 700, key: 100, detail: "Docs layout", check: "build", queued: 100 },
          { kind: "park", since: 50, key: 50 },
        ],
        nulls: [{ kind: "ci_failing", since: 1, key: 0, agent: null, detail: null, check: null, queued: null }],
        "unknown kind": [{ kind: "asking", since: 1, key: 1 }],
        "detail not text": [{ kind: "park", since: 1, key: 1, detail: 5 }],
        "long detail": [{ kind: "park", since: 1, key: 1, detail: "d".repeat(121) }],
        "padded detail": [{ kind: "park", since: 1, key: 1, detail: " x" }],
        "check on red": [{ kind: "ci_failing", since: 1, key: 1, check: "build" }],
        "queued on a park": [{ kind: "park", since: 1, key: 1, queued: 1 }],
        "stop with no agent": [{ kind: "stopped", since: 1, key: 1 }],
        "agent on ci": [{ kind: "merge_ready", since: 1, key: 1, agent: "s1" }],
        "one bad": [
          { kind: "park", since: 1, key: 1 },
          { kind: "park", since: -1, key: 1 },
        ],
        "no key": [{ kind: "park", since: 1 }],
        empty: [],
        junk: "x",
        ["__proto__"]: [{ kind: "park", since: 1, key: 1 }],
      },
    });
    assert.deepEqual(state.waits, {
      w1: [
        stop,
        { kind: "ci_stuck", since: 700, key: 100, detail: "Docs layout", check: "build", queued: 100 },
        park(50),
      ],
      nulls: [{ kind: "ci_failing", since: 1, key: 0 }],
    });
  });

  it("keeps MAX_WAITS waits a workspace at most, and leaves the map out while empty", () => {
    const many = Array.from({ length: MAX_WAITS + 1 }, () => park(1));
    assert.equal(validateState({ waits: { w: many } }).waits, undefined);
    assert.equal(validateState({ waits: { w: many.slice(1) } }).waits?.w?.length, MAX_WAITS);
    assert.equal("waits" in validateState({}), false);
  });
});

describe("parseWaitsSave", () => {
  it("reads the native effect's JSON, nulls and whole floats included", () => {
    assert.ok(native, "effects.json holds a SaveWaits entry");
    const input = parseWaitsSave(JSON.stringify(native));
    assert.ok(input.ok);
    assert.deepEqual(input.remove, ["W2"]);
    assert.equal(input.skipped, 0);
    assert.deepEqual(input.set, {
      W1: [
        { kind: "stopped", since: 1791229800, key: 1791229800, agent: "s1", detail: "error" },
        {
          kind: "ci_stuck",
          since: 1791229800,
          key: 1791229200,
          detail: "Docs layout",
          check: "build",
          queued: 1791229200,
        },
      ],
    });
  });

  it("skips a list the contract refuses rather than deleting what the file holds", () => {
    const input = parseWaitsSave(JSON.stringify({ a: [{ kind: "stopped", since: 1, key: 1 }], b: [stop] }));
    assert.ok(input.ok);
    assert.deepEqual(input.set, { b: [stop] });
    assert.deepEqual(input.remove, []);
    assert.equal(input.skipped, 1);
  });

  it("refuses what is not a JSON map", () => {
    for (const bad of [undefined, "", "{", "[]", "null", '"x"']) {
      assert.equal(parseWaitsSave(bad).ok, false, String(bad));
    }
  });
});

describe("writeWaitEntries", () => {
  it("sets and deletes only the entries given, keeps the rest, and says when nothing changed", () => {
    const path = fileIn("entries.json", { waits: { a: [park(1)], b: [park(1)] }, dismissed: { x: { s: 1 } } });
    assert.deepEqual(writeWaitEntries(path, { a: [stop], c: [park(2)] }, ["b"]), { ok: true, changed: true });
    const state = read(path);
    assert.deepEqual(state.waits, { a: [stop], c: [park(2)] });
    assert.deepEqual(Object.keys(state.dismissed), ["x"], "other maps stay");
    assert.deepEqual(writeWaitEntries(path, { a: [stop] }, []), { ok: true, changed: false });
    writeWaitEntries(path, {}, ["a", "c"]);
    assert.equal("waits" in read(path), false, "an emptied map is left out");
  });
});
