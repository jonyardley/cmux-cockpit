// A workspace's subagent runs from the saved state (issue #6): cmux sends
// custom sidebars no subagents, so the hook's saved copy shows instead, and
// cmux's own `children` win the day any agent carries some. __STATE__ is set
// before the renderer import, as in prs-saved.test.ts.

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
  subagents: {
    w1: [run("a", { startedEpoch: 100, endedEpoch: 200 }), run("b", { startedEpoch: 300 })],
    matched: [run("m", { session: "owner", startedEpoch: 100 })],
    allEnded: [run("stuck", { startedEpoch: 100 })],
    many: [0, 1, 2, 3, 4, 5].map((i) => run("r" + i, { startedEpoch: 100 + i })),
  },
};

const { installRenderer } = await import("./support/renderer.ts");
const r = installRenderer();
const { agent, ws } = await import("./support/fixtures.ts");
const m = await import("../src/agents/model.ts");

const ids = () => m.subagents().map((e) => e.key.split(":")[2]);

describe("saved subagent runs", () => {
  it("is empty for a workspace with no saved runs", () => {
    r.data.workspaces = [ws("none", { selected: true, agents: [agent("working")] })];
    assert.deepEqual(m.subagents(), []);
  });

  it("shows the saved runs when no agent carries cmux's own children", () => {
    r.data.workspaces = [ws("w1", { selected: true, agents: [agent("working")] })];
    assert.deepEqual(ids(), ["b", "a"]);
  });

  it("lets cmux's own children win once any agent carries some, adding only saved runs still live (#83)", () => {
    // "b" has no end, so it shows even though cmux no longer sends it; "a"
    // ended, so only cmux's children would have kept it.
    r.data.workspaces = [
      ws("w1", {
        selected: true,
        agents: [agent("working", { children: [{ id: "c", running: true, startedEpoch: 900 }] })],
      }),
    ];
    assert.deepEqual(ids(), ["b", "c"]);
  });

  it("falls back to saved runs when cmux sends only holes, no truthy child", () => {
    // cmux has sent holes in agent lists before (test/agents.test.ts); an
    // all-holes children array must not be read as "cmux has its own data".
    // The cast holds because the model only ever reads a hole through the
    // same falsy check childRanked already survives.
    const holesOnly: SubagentRun[] = [null as unknown as SubagentRun];
    r.data.workspaces = [ws("w1", { selected: true, agents: [agent("working", { children: holesOnly })] })];
    assert.deepEqual(ids(), ["b", "a"]);
  });

  it("reads a saved run with no end as running while a workspace agent is still live", () => {
    r.data.workspaces = [ws("w1", { selected: true, agents: [agent("working")] })];
    const [live, done] = m.subagents();
    assert.ok(live && done);
    assert.equal(live.running, true);
    assert.equal(done.running, false);
  });

  it("never ticks a run on once every workspace agent has ended, even without its own end", () => {
    r.data.workspaces = [ws("allEnded", { selected: true, agents: [agent("ended")] })];
    assert.deepEqual(
      m.subagents().map((e) => e.running),
      [false],
    );
  });

  it("owns a run by the agent whose id matches its session, and follows that agent's status", () => {
    const owner = agent("ended", { id: "owner" });
    r.data.workspaces = [ws("matched", { selected: true, agents: [owner, agent("working")] })];
    assert.deepEqual(
      m.subagents().map((e) => [e.key, e.running]),
      [["s:owner:m", false]],
    );
  });

  it("keeps every saved run, and caps the helpers listed at 5, running first oldest-start first", () => {
    r.data.workspaces = [ws("many", { selected: true, agents: [agent("working")] })];
    assert.equal(m.subagents().length, 6);
    const rows = m.helpers();
    assert.equal(rows.length, 5);
    assert.deepEqual(
      rows.map((e) => e.key.split(":")[2]),
      rows.map((_, i) => "r" + i),
    );
    assert.equal(new Set(rows.map((e) => e.key)).size, 5);
  });
});
