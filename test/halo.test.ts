import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { installRenderer } from "./support/renderer.ts";

const r = installRenderer();
const { agent, ws } = await import("./support/fixtures.ts");
const { haloSize, haloStatus } = await import("../src/shared/ui.ts");
const { C } = await import("../src/cockpit/theme.ts");
const { T } = await import("../src/agents/theme.ts");
const { laneByKey } = await import("../src/cockpit/lanes.ts");
const status = await import("../src/cockpit/status.ts");
const { dismissNeeds } = await import("../src/shared/needs.ts");
const agentsModel = await import("../src/agents/model.ts");

const haloOf = (w: Workspace | undefined) => status.statusInfo(w).halo;

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

describe("cockpit status halo", () => {
  it("rings working and needs dots only", () => {
    assert.equal(haloOf(ws("w", { agents: [agent("working")] })), C.blueHalo);
    assert.equal(haloOf(ws("n", { agents: [agent("needs_input")] })), C.clayHalo);
    assert.equal(haloOf(ws("i", { agents: [agent("idle")] })), "clear");
    assert.equal(haloOf(ws("e", { agents: [agent("ended")] })), "clear");
    assert.equal(haloOf(ws("q")), "clear");
  });

  it("drops the halo once needs you is dismissed", () => {
    r.data.epoch += 100;
    const w = ws("d", { agents: [agent("needs_input", { sinceEpoch: 500 })] });
    dismissNeeds(w);
    assert.equal(haloOf(w), "clear");
  });
});

describe("lane colours", () => {
  it("uses board 1's tokens for Background and Unsorted", () => {
    assert.equal(laneByKey("bg").color, C.laneBackground);
    assert.equal(laneByKey("unsorted").color, C.laneUnsorted);
  });
});
