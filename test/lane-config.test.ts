// config/lanes.json's rules, as the native core's Lanes::from_config holds
// them (native/core/src/lanes.rs): the same file must give both sidebars
// the same table, or fail in both.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  BUILT_IN_LANES,
  builtInName,
  type LaneSpec,
  resolveLanes,
  unrecordedLanes,
} from "../src/cockpit/lane-config.ts";

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

  it("takes any lane token, the three hues included", () => {
    const colors = lanes([
      { name: "Violet", color: "laneViolet" },
      { name: "Teal", color: "laneTeal" },
      { name: "Rose", color: "laneRose" },
      { id: "main", name: "Token", color: "laneParked" },
    ]).map((l) => l.color);
    assert.deepEqual(colors, ["laneViolet", "laneTeal", "laneRose", "laneParked"]);
  });

  it("reads the committed sample, as the core does", () => {
    const sample = lanes(JSON.parse(readFileSync("config/lanes.example.json", "utf8")));
    assert.deepEqual(
      sample.map((l) => [l.name, l.color]),
      [
        ["Doing", "laneMain"],
        ["Waiting on others", "laneTeal"],
        ["Ideas", "laneRose"],
        ["Parked", "laneParked"],
      ],
    );
  });

  it("refuses what it cannot draw", () => {
    assert.match(error({}), /JSON array/);
    assert.match(error(["Ideas"]), /object/);
    assert.match(error([{}]), /no name/);
    assert.match(error([{ name: "  " }]), /no name/);
    assert.match(error([{ name: "A", id: " " }]), /empty id/);
    assert.match(error([{ name: "A", id: 3 }]), /id must be a string/);
    for (const bad of ["red", "heading", "violet", "#c63", "#CC6633", "#cc663380", "#12", "123456", "#"])
      assert.match(error([{ name: "A", color: bad }]), /unknown colour/, bad);
    assert.match(error([{ name: "A", color: 1 }]), /color must be a string/);
    assert.match(error([{ name: "A", density: "tall" }]), /unknown density "tall"/);
    assert.match(error([{ name: "A", faint: "yes" }]), /faint must be true or false/);
  });

  it("says what to use instead of a hex, in the core's words and token list", () => {
    const message = error([{ name: "Ideas", color: "#c63" }]);
    assert.match(
      message,
      /^lane "Ideas": unknown colour "#c63"; use a lane token \(laneMain, .* or laneRose\); a hex is not taken$/,
    );
    const hint = message.slice(message.indexOf("use a lane token"));
    assert.ok(readFileSync("native/core/src/lanes.rs", "utf8").includes(`"${hint}"`), "lanes.rs gives the same hint");
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

describe("the lanes the build saves a name for", () => {
  const table = resolveLanes([{ id: "main", name: "Doing" }, { name: "Ideas" }, { id: "shelf", name: "Shelf" }]);
  assert.ok(table.ok);

  it("takes a built-in lane's name by id", () => {
    assert.equal(builtInName("parked"), "Parked");
    assert.equal(builtInName("shelf"), undefined);
  });

  it("is each lane neither saved nor built in", () => {
    assert.deepEqual(
      unrecordedLanes(table.lanes, undefined).map((l) => l.id),
      ["Ideas", "shelf"],
    );
    assert.deepEqual(
      unrecordedLanes(table.lanes, { shelf: "Shelf" }).map((l) => l.id),
      ["Ideas"],
    );
  });
});
