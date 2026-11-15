import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { installRenderer } from "./support/renderer.ts";

installRenderer();
const { agent } = await import("./support/fixtures.ts");
const { haloSize, haloStatus } = await import("../src/shared/ui.ts");
const { T } = await import("../src/agents/theme.ts");
const agentsModel = await import("../src/agents/model.ts");

describe("haloSize", () => {
  it("is board 1's 13pt round a 7pt dot, 3pt each side", () => {
    assert.equal(haloSize(7), 13);
    assert.equal(haloSize(6), 12);
  });
});

describe("haloStatus", () => {
  it("is the one decision behind board 1's halo: working and needs only", () => {
    assert.equal(haloStatus("working"), "working");
    assert.equal(haloStatus("needs_input"), "needs_input");
    assert.equal(haloStatus("idle"), null);
    assert.equal(haloStatus("ended"), null);
    assert.equal(haloStatus("none"), null);
    assert.equal(haloStatus(undefined), null);
  });
});

describe("agents halo", () => {
  it("maps the shared halo decision to the agents panel's own tokens", () => {
    assert.equal(agentsModel.haloFor(agent("working")), T.blueHalo);
    assert.equal(agentsModel.haloFor(agent("needs_input")), T.clayHalo);
    assert.equal(agentsModel.haloFor(agent("idle")), "clear");
    assert.equal(agentsModel.haloFor(agent("ended")), "clear");
    assert.equal(agentsModel.haloFor(null), "clear");
  });
});
