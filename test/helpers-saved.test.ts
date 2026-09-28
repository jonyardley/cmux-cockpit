// A card's helper count from the saved subagent runs (issues #6 and #47):
// cmux sends custom sidebars no subagents, so the count falls back on the
// hook's saved copy while no agent carries cmux's own children. __STATE__ is
// set before the renderer import, as in subagents-saved.test.ts.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

const run = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  session: "sess-" + id,
  label: "Label " + id,
  startedEpoch: 100,
  ...extra,
});

(globalThis as Record<string, unknown>).__STATE__ = {
  dismissed: {},
  projectOverride: {},
  projects: {},
  prs: {},
  ownPrs: {},
  // The built state always carries ui (validateState); status.ts reads
  // selection from state.ts, which reads the saved folds at import.
  ui: {},
  subagents: {
    w1: [run("a", { endedEpoch: 200 }), run("b"), run("c")],
    matched: [run("m", { session: "owner" })],
  },
};

const { installRenderer } = await import("./support/renderer.ts");
const r = installRenderer();
const { agent, ws } = await import("./support/fixtures.ts");
const { liveRunCount } = await import("../src/shared/subagents.ts");
const { helperText } = await import("../src/cockpit/status.ts");

describe("saved helper count", () => {
  it("counts saved runs with no end while a workspace agent is live", () => {
    const w = ws("w1", { agents: [agent("working")] });
    assert.equal(liveRunCount(w), 2);
    assert.equal(helperText(w), "· 2 helpers");
  });

  it("counts none once every workspace agent has ended", () => {
    assert.equal(liveRunCount(ws("w1", { agents: [agent("ended")] })), 0);
  });

  it("follows the owning agent's status when the session matches", () => {
    const owner = agent("ended", { id: "owner" });
    assert.equal(liveRunCount(ws("matched", { agents: [owner, agent("working")] })), 0);
  });

  it("counts cmux's own children once any agent carries some, with the saved runs still live (#83)", () => {
    // cmux settled "c", but its saved run has no end, so it still counts;
    // "b" is live and cmux no longer sends it; "a" ended, so it does not.
    const w = ws("w1", { agents: [agent("working", { children: [{ id: "c", running: false, endedEpoch: 5 }] })] });
    assert.equal(liveRunCount(w), 2);
    const ended = ws("w1", { agents: [agent("working", { children: [{ id: "a", running: false, endedEpoch: 5 }] })] });
    assert.equal(liveRunCount(ended), 2);
  });

  it("counts nothing for a workspace with no saved runs", () => {
    r.data.epoch += 1;
    assert.equal(liveRunCount(ws("none", { agents: [agent("working")] })), 0);
  });
});
