// config/lanes.json's names, the only part of it the build checks.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { BUILT_IN_LANE_NAMES, laneNames } from "../scripts/lanes-config.ts";

const names = (raw: unknown): readonly string[] => {
  const r = laneNames(raw);
  assert.ok(r.ok, r.ok ? "" : r.error);
  return r.names;
};
const error = (raw: unknown): string => {
  const r = laneNames(raw);
  return r.ok ? "" : r.error;
};

describe("lanes.json names", () => {
  it("gives today's four for an empty array", () => {
    assert.deepEqual(names([]), ["Main activity", "For review", "Background", "Parked"]);
    assert.equal(names([]), BUILT_IN_LANE_NAMES);
  });

  it("keeps the file's order, trims each name and ignores every other field", () => {
    assert.deepEqual(
      names([
        { name: " Ideas ", color: "#c63", density: "tall", colour: "laneMain" },
        { id: "main", name: "Main activity" },
      ]),
      ["Ideas", "Main activity"],
    );
  });

  it("reads the committed sample", () => {
    const sample = names(JSON.parse(readFileSync("config/lanes.example.json", "utf8")));
    assert.deepEqual(sample, ["Doing", "Waiting on others", "Ideas", "Parked"]);
  });

  it("refuses a file that is not a list of named lanes", () => {
    assert.match(error({}), /JSON array/);
    assert.match(error(["Ideas"]), /object/);
    assert.match(error([null]), /object/);
    assert.match(error([{}]), /no name/);
    assert.match(error([{ name: "  " }]), /no name/);
    assert.match(error([{ name: 3 }]), /no name/);
  });

  it("refuses a name used twice, in any case and spacing", () => {
    assert.match(error([{ name: "Ideas" }, { name: " IDEAS " }]), /two lanes are named "IDEAS"/);
  });

  it("refuses Unsorted's name in any case", () => {
    assert.match(error([{ name: "Unsorted" }]), /Unsorted's/);
    assert.match(error([{ name: " UNSORTED " }]), /Unsorted's/);
  });
});
