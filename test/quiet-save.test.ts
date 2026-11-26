// Issue #425: the native core decides whether a card's agent is quiet,
// since only it can see a chat's runs from before a `/clear`. Its
// SaveQuiet effect reaches scripts/quiet-save.ts as JSON (the shape
// native/runner/tests/effects.json pins for the Rust side), which writes
// it in config/state.json's `quiet` map for the agents panel to read.

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { parseQuietSave } from "../scripts/quiet-save.ts";
import { validateState } from "../scripts/state-config.ts";
import { writeQuietEntries } from "../scripts/state-url.ts";

const dir = mkdtempSync(join(tmpdir(), "quiet-save-"));
after(() => rmSync(dir, { recursive: true, force: true }));
const fileIn = (name: string, state: unknown): string => {
  const path = join(dir, name);
  writeFileSync(path, JSON.stringify(state));
  return path;
};
const read = (path: string) => validateState(JSON.parse(readFileSync(path, "utf8")));

const effects: unknown = JSON.parse(
  readFileSync(join(import.meta.dirname, "..", "native", "runner", "tests", "effects.json"), "utf8"),
);
const native = (Array.isArray(effects) ? effects : []).find((e) => e && typeof e === "object" && "SaveQuiet" in e)
  ?.SaveQuiet?.quiet;

describe("the quiet map's contract", () => {
  it("reads verdicts as persist.rs's quiet_map does", () => {
    // The same sample as persist.rs's reads_quiet_verdicts_as_validate_state_does.
    const state = validateState({
      quiet: {
        w1: { agent: "s1", since: 100.5, extra: 1 },
        "bad since": { agent: "s1", since: -1 },
        "no since": { agent: "s1" },
        "no agent": { agent: "", since: 100 },
        junk: "x",
        ["__proto__"]: { agent: "s1", since: 100 },
      },
    });
    assert.deepEqual(state.quiet, { w1: { agent: "s1", since: 100.5 } });
    assert.equal("quiet" in validateState({}), false, "left out while empty");
  });
});

describe("parseQuietSave", () => {
  it("reads the native effect's JSON, nulls and whole floats included", () => {
    assert.ok(native, "effects.json holds a SaveQuiet entry");
    const input = parseQuietSave(JSON.stringify(native));
    assert.ok(input.ok);
    assert.deepEqual(input.remove, ["W2"]);
    assert.equal(input.skipped, 0);
    assert.deepEqual(input.set, { W1: { agent: "s1", since: 1791229800 } });
  });

  it("skips an entry the contract refuses rather than deleting what the file holds", () => {
    const good = { agent: "s", since: 5 };
    const input = parseQuietSave(JSON.stringify({ a: { agent: "s" }, b: good }));
    assert.ok(input.ok);
    assert.deepEqual(input.set, { b: good });
    assert.deepEqual(input.remove, []);
    assert.equal(input.skipped, 1);
  });

  it("refuses what is not a JSON map", () => {
    for (const bad of [undefined, "", "{", "[]", "null", '"x"']) {
      assert.equal(parseQuietSave(bad).ok, false, String(bad));
    }
  });
});

describe("writeQuietEntries", () => {
  it("sets and deletes only the entries given, keeps the rest, and says when nothing changed", () => {
    const one = { agent: "s", since: 5 };
    const two = { agent: "s", since: 6 };
    const path = fileIn("entries.json", { quiet: { a: one, b: one }, dismissed: { x: { s: 1 } } });
    assert.deepEqual(writeQuietEntries(path, { a: two, c: one }, ["b"]), { ok: true, changed: true });
    const state = read(path);
    assert.deepEqual(state.quiet, { a: two, c: one });
    assert.deepEqual(Object.keys(state.dismissed), ["x"], "other maps stay");
    assert.deepEqual(writeQuietEntries(path, { a: two }, []), { ok: true, changed: false });
    writeQuietEntries(path, {}, ["a", "c"]);
    assert.equal("quiet" in read(path), false, "an emptied map is left out");
  });
});
