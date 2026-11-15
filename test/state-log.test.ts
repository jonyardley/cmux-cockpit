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

  it("names the writes it coalesced, counting repeats, and the keys that changed", () => {
    const tags = ["report-subagent", "report-move", "report-subagent", "report-subagent"];
    assert.equal(
      redrawLine(["cockpit"], { tags, changed: ["moves", "subagents"] }),
      "build: redrew cockpit; writes report-subagent x3, report-move; changed moves, subagents",
    );
  });

  it("says none when no write asked for the build and no key changed", () => {
    assert.equal(redrawLine([], { tags: [], changed: [] }), "build: redrew nothing; writes none; changed none");
  });

  it("says so when the state file could not be read", () => {
    assert.equal(
      redrawLine(["agents"], { tags: ["state-set"], changed: null }),
      "build: redrew agents; writes state-set; changed state unreadable",
    );
  });
});
