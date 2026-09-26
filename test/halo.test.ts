import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { installRenderer } from "./support/renderer.ts";

const r = installRenderer();
const { agent, ws } = await import("./support/fixtures.ts");
const { haloSize } = await import("../src/shared/ui.ts");
const { C } = await import("../src/cockpit/theme.ts");
const { laneByKey } = await import("../src/cockpit/lanes.ts");
const status = await import("../src/cockpit/status.ts");

const haloOf = (w: Workspace | undefined) => status.statusInfo(w).halo;

describe("haloSize", () => {
  it("is board 1's 13pt round a 7pt dot, 3pt each side", () => {
    assert.equal(haloSize(7), 13);
    assert.equal(haloSize(6), 12);
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
    status.dismissNeeds(w);
    assert.equal(haloOf(w), "clear");
  });
});

describe("lane colours", () => {
  it("uses board 1's tokens for Background and Unsorted", () => {
    assert.equal(laneByKey("bg").color, C.laneBackground);
    assert.equal(laneByKey("unsorted").color, C.laneUnsorted);
  });
});
