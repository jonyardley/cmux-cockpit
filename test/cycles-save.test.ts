// Issue #399, lane 2a: the native core saves each Ostinato cycle a card
// carries. Its SaveCycles effect reaches scripts/cycles-save.ts as JSON
// (the shape native/runner/tests/effects.json pins for the Rust side),
// which writes it in config/state.json's `cycles` map for the agents
// panel's Details tab to read.

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { parseCyclesSave } from "../scripts/cycles-save.ts";
import { MAX_CYCLES, type SavedCycle, validateState } from "../scripts/state-config.ts";
import { writeCycleEntries } from "../scripts/state-url.ts";

const dir = mkdtempSync(join(tmpdir(), "cycles-save-"));
after(() => rmSync(dir, { recursive: true, force: true }));
const fileIn = (name: string, state: unknown): string => {
  const path = join(dir, name);
  writeFileSync(path, JSON.stringify(state));
  return path;
};
const read = (path: string) => validateState(JSON.parse(readFileSync(path, "utf8")));

const cycle = (item: string): SavedCycle => ({ item });

// The SaveCycles entry the Rust tests hold the bridge's JSON to.
const effects: unknown = JSON.parse(
  readFileSync(join(import.meta.dirname, "..", "native", "runner", "tests", "effects.json"), "utf8"),
);
const native = (Array.isArray(effects) ? effects : []).find((e) => e && typeof e === "object" && "SaveCycles" in e)
  ?.SaveCycles?.cycles;

const full: SavedCycle = {
  item: "app#12",
  url: "https://github.com/o/app/issues/12",
  attempt: 1,
  outcome: "parked",
  reason: "needs_decision",
  question: "Rerun CI once main is green?",
  pr: "app#40",
  sessions: ["s1"],
  cost: 2.5,
  started: 1791229200,
  ended: 1791229800,
  stages: [
    { name: "brief", at: 1791229260, secs: 60, sessions: ["s1"] },
    { name: "parked", at: 1791229700, secs: 440, sessions: ["s1"] },
  ],
};

describe("the cycles map's contract", () => {
  it("reads cycles as persist.rs's cycles_map does", () => {
    const state = validateState({
      cycles: {
        w1: [
          { ...full, extra: 1 },
          { item: "app#13", url: null, sessions: [], stages: [] },
        ],
        "no item": [{ attempt: 1 }],
        "attempt zero": [{ item: "a#1", attempt: 0 }],
        "attempt not whole": [{ item: "a#1", attempt: 1.5 }],
        "padded item": [{ item: " a#1" }],
        "long question": [{ item: "a#1", question: "q".repeat(121) }],
        "long url": [{ item: "a#1", url: `https://x/${"u".repeat(510)}` }],
        "null sessions": [{ item: "a#1", sessions: null }],
        "too many sessions": [{ item: "a#1", sessions: Array.from({ length: 9 }, (_, i) => `s${i}`) }],
        "stage below zero": [{ item: "a#1", stages: [{ name: "qa", at: 1, secs: -1 }] }],
        "cost below zero": [{ item: "a#1", cost: -1 }],
        "one bad": [cycle("a#1"), { item: 5 }],
        empty: [],
        ["__proto__"]: [cycle("a#1")],
      },
    });
    assert.deepEqual(state.cycles, { w1: [full, cycle("app#13")] });
  });

  it("keeps MAX_CYCLES cycles a workspace at most, and leaves the map out while empty", () => {
    const many = Array.from({ length: MAX_CYCLES + 1 }, (_, i) => cycle(`a#${i}`));
    assert.equal(validateState({ cycles: { w: many } }).cycles, undefined);
    assert.equal(validateState({ cycles: { w: many.slice(1) } }).cycles?.w?.length, MAX_CYCLES);
    assert.equal("cycles" in validateState({}), false);
  });
});

describe("parseCyclesSave", () => {
  it("reads the native effect's JSON unchanged, nulls and whole floats included", () => {
    assert.ok(native, "effects.json holds a SaveCycles entry");
    const input = parseCyclesSave(JSON.stringify(native));
    assert.ok(input.ok);
    assert.deepEqual(input.remove, ["W2"]);
    assert.equal(input.skipped, 0);
    assert.deepEqual(input.set, { W1: [full] });
    assert.deepEqual(input.set, { W1: native.W1 }, "what the core sends reads back the same");
  });

  it("skips a list the contract refuses rather than deleting what the file holds", () => {
    const input = parseCyclesSave(JSON.stringify({ a: [{ attempt: 1 }], b: [full] }));
    assert.ok(input.ok);
    assert.deepEqual(input.set, { b: [full] });
    assert.deepEqual(input.remove, []);
    assert.equal(input.skipped, 1);
  });

  it("refuses what is not a JSON map", () => {
    for (const bad of [undefined, "", "{", "[]", "null", '"x"']) {
      assert.equal(parseCyclesSave(bad).ok, false, String(bad));
    }
  });
});

describe("writeCycleEntries", () => {
  it("sets and deletes only the entries given, keeps the rest, and says when nothing changed", () => {
    const path = fileIn("entries.json", {
      cycles: { a: [cycle("a#1")], b: [cycle("b#1")] },
      dismissed: { x: { s: 1 } },
    });
    assert.deepEqual(writeCycleEntries(path, { a: [full], c: [cycle("c#1")] }, ["b"]), {
      ok: true,
      changed: true,
    });
    const state = read(path);
    assert.deepEqual(state.cycles, { a: [full], c: [cycle("c#1")] });
    assert.deepEqual(Object.keys(state.dismissed), ["x"], "other maps stay");
    assert.deepEqual(writeCycleEntries(path, { a: [full] }, []), { ok: true, changed: false });
    writeCycleEntries(path, {}, ["a", "c"]);
    assert.equal("cycles" in read(path), false, "an emptied map is left out");
  });
});
