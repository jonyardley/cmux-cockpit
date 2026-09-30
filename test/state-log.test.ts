import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { redrawLine } from "../scripts/state-log.ts";

describe("redrawLine", () => {
  it("names each sidebar a build rewrote", () => {
    assert.equal(redrawLine(["agents", "cockpit"]), "build: redrew agents, cockpit");
  });

  it("says so when a build rewrote none", () => {
    assert.equal(redrawLine([]), "build: redrew nothing");
  });
});
