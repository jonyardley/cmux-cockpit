// Issue #83: cmux's own `children` can settle a background subagent the
// moment its Agent call returns, while the hook's saved run (paired, no end,
// owner still working) knows it is still going. The saved run vouches for
// the child, so it reads as running; a run the hook ended stays settled.
// __STATE__ is set before the renderer import, as in subagents-saved.test.ts.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

const saved = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  session: "owner",
  agentId: "agent-" + id,
  label: "Lane " + id,
  startedEpoch: 1000,
  ...extra,
});

(globalThis as Record<string, unknown>).__STATE__ = {
  dismissed: {},
  projectOverride: {},
  projects: {},
  prs: {},
  ownPrs: {},
  subagents: {
    live: [saved("a"), saved("b")],
    ended: [saved("a", { endedEpoch: 1100 })],
  },
};

const { installRenderer } = await import("./support/renderer.ts");
const r = installRenderer();
const { agent, ws } = await import("./support/fixtures.ts");
const m = await import("../src/agents/model.ts");
const { liveRunCount } = await import("../src/shared/subagents.ts");

// cmux's view of a background run: settled a moment after it started.
const settled = (id: string, label: string): SubagentRun => ({
  id,
  label,
  running: false,
  startedEpoch: 1000,
  endedEpoch: 1001,
});

const rows = () => m.subagents().map((e) => [e.key, e.label, e.running]);

describe("saved runs vouching for cmux's children (#83)", () => {
  it("reads a child cmux settled as running while its saved run has no end and its owner works", () => {
    const owner = agent("working", {
      id: "owner",
      children: [settled("agent-a", "Lane a"), settled("agent-b", "Other name")],
    });
    r.data.workspaces = [ws("live", { selected: true, agents: [owner] })];
    assert.deepEqual(rows(), [
      ["s:owner:agent-a", "Lane a", true],
      ["s:owner:agent-b", "Other name", true],
    ]);
    const [first] = m.subagents();
    assert.equal(first?.endedEpoch, undefined);
  });

  it("matches a child by the Agent call's id, or by label when cmux's id is its own", () => {
    const owner = agent("working", { id: "owner", children: [settled("a", "?"), settled("cmux-9", "Lane b")] });
    r.data.workspaces = [ws("live", { selected: true, agents: [owner] })];
    assert.deepEqual(
      m.subagents().map((e) => e.running),
      [true, true],
    );
  });

  it("keeps a child settled when the hook ended its saved run too", () => {
    const owner = agent("working", { id: "owner", children: [settled("agent-a", "Lane a")] });
    r.data.workspaces = [ws("ended", { selected: true, agents: [owner] })];
    assert.deepEqual(rows(), [["s:owner:agent-a", "Lane a", false]]);
  });

  it("keeps a child settled once its owner has ended", () => {
    const owner = agent("ended", { id: "owner", children: [settled("agent-a", "Lane a")] });
    r.data.workspaces = [ws("live", { selected: true, agents: [owner] })];
    assert.deepEqual(
      m.subagents().map((e) => e.running),
      [false],
    );
  });

  it("adds a live saved run cmux has already pruned, once, beside the children it still sends", () => {
    const owner = agent("working", { id: "owner", children: [settled("agent-a", "Lane a")] });
    r.data.workspaces = [ws("live", { selected: true, agents: [owner] })];
    assert.deepEqual(rows(), [
      ["s:owner:agent-a", "Lane a", true],
      ["s:owner:b", "Lane b", true],
    ]);
  });

  it("leaves an unmatched child cmux settled as settled", () => {
    const owner = agent("working", { id: "owner", children: [settled("other", "Something else")] });
    r.data.workspaces = [ws("ended", { selected: true, agents: [owner] })];
    assert.deepEqual(rows(), [["s:owner:other", "Something else", false]]);
  });

  it("counts vouched children and unclaimed live saved runs once each on the cockpit card", () => {
    const owner = agent("working", { id: "owner", children: [settled("agent-a", "Lane a")] });
    assert.equal(liveRunCount(ws("live", { agents: [owner] })), 2);
    assert.equal(liveRunCount(ws("ended", { agents: [owner] })), 0);
  });
});
