// config/lanes.json's rules, as the native core's Lanes::from_config holds
// them (native/core/src/lanes.rs): the same file must give both sidebars
// the same table, or fail in both.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BUILT_IN_LANES, type LaneSpec, resolveLanes } from "../src/cockpit/lane-config.ts";

const lanes = (raw: unknown): readonly LaneSpec[] => {
  const r = resolveLanes(raw);
  assert.ok(r.ok, r.ok ? "" : r.error);
  return r.lanes;
};
const error = (raw: unknown): string => {
  const r = resolveLanes(raw);
  return r.ok ? "" : r.error;
};

describe("lanes.json", () => {
  it("gives today's four for an empty array", () => {
    assert.deepEqual(lanes([]), BUILT_IN_LANES);
    assert.deepEqual(
      BUILT_IN_LANES.map((l) => [l.id, l.name, l.folded, l.faint, l.leftOff]),
      [
        ["main", "Main activity", false, false, false],
        ["review", "For review", false, false, false],
        ["bg", "Background", false, false, true],
        ["parked", "Parked", true, true, true],
      ],
    );
  });

  it("takes a missing field from the built-in lane with the same id", () => {
    const [shelf] = lanes([{ id: "parked", name: "Shelf" }]);
    assert.deepEqual(shelf, {
      id: "parked",
      name: "Shelf",
      color: "laneParked",
      density: "row",
      folded: true,
      faint: true,
      leftOff: true,
    });
  });

  it("sets faint apart from folded", () => {
    const [shelf] = lanes([{ id: "parked", name: "Shelf", folded: false }]);
    assert.equal(shelf?.folded, false);
    assert.equal(shelf?.faint, true);
  });

  it("makes a new lane compact, unfolded and plain in Unsorted's colour, its id its name", () => {
    assert.deepEqual(lanes([{ name: " Ideas " }]), [
      {
        id: "Ideas",
        name: "Ideas",
        color: "laneUnsorted",
        density: "compact",
        folded: false,
        faint: false,
        leftOff: false,
      },
    ]);
  });

  it("keeps the file's order and every field it sets", () => {
    const table = lanes([
      { name: "Ideas", color: "laneReview", density: "full", folded: true, faint: true, leftOff: true },
      { id: "main", name: "Main activity" },
    ]);
    assert.deepEqual(
      table.map((l) => l.id),
      ["Ideas", "main"],
    );
    assert.deepEqual(table[0], {
      id: "Ideas",
      name: "Ideas",
      color: "laneReview",
      density: "full",
      folded: true,
      faint: true,
      leftOff: true,
    });
  });

  it("reads a field set to null as left out, as the native core does", () => {
    assert.deepEqual(lanes([{ id: null, name: "Ideas", color: null, density: null, folded: null }]), [
      {
        id: "Ideas",
        name: "Ideas",
        color: "laneUnsorted",
        density: "compact",
        folded: false,
        faint: false,
        leftOff: false,
      },
    ]);
    assert.deepEqual(lanes([{ id: "parked", name: "Shelf", faint: null, leftOff: null }]), [
      { ...BUILT_IN_LANES[3], name: "Shelf" },
    ]);
  });

  it("refuses what it cannot draw", () => {
    assert.match(error({}), /JSON array/);
    assert.match(error(["Ideas"]), /object/);
    assert.match(error([{}]), /no name/);
    assert.match(error([{ name: "  " }]), /no name/);
    assert.match(error([{ name: "A", id: " " }]), /empty id/);
    assert.match(error([{ name: "A", id: 3 }]), /id must be a string/);
    assert.match(error([{ name: "A", color: "#ff0000" }]), /unknown colour "#ff0000"/);
    assert.match(error([{ name: "A", color: 1 }]), /color must be a string/);
    assert.match(error([{ name: "A", density: "tall" }]), /unknown density "tall"/);
    assert.match(error([{ name: "A", faint: "yes" }]), /faint must be true or false/);
  });

  it("refuses a field it does not know, so a typo is not ignored", () => {
    assert.match(error([{ name: "A", colour: "laneMain" }]), /unknown field "colour"/);
    assert.match(error([{ name: "A", left_off: true }]), /unknown field "left_off"/);
  });

  it("refuses an id or group name used twice, names in any case", () => {
    assert.match(error([{ name: "A" }, { id: "A", name: "B" }]), /two lanes have the id "A"/);
    assert.match(
      error([
        { id: "a", name: "Ideas" },
        { id: "b", name: "IDEAS" },
      ]),
      /two lanes are named "IDEAS"/,
    );
    assert.ok(
      lanes([
        { id: "a", name: "A" },
        { id: "A", name: "B" },
      ]),
    );
  });

  it("refuses Unsorted's id or name in any case", () => {
    assert.match(error([{ name: "Unsorted" }]), /Unsorted's/);
    assert.match(error([{ id: "UNSORTED", name: "Loose" }]), /Unsorted's/);
  });
});
