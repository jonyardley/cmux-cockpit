// A quiet agent: working, but silent for ten minutes with nothing of its own
// running, as the agents panel's head status reads it from the native
// core's saved verdict (#425). The panel keeps no rule of its own: it drops
// a verdict that is not about the agent, or that the agent has outrun.

import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { validateState } from "../scripts/state-config.ts";

const NOW = 1_000_000;
const SINCE = NOW - 17 * 60;

(globalThis as Record<string, unknown>).__STATE__ = validateState({
  quiet: {
    quiet: { agent: "c1", since: SINCE },
    other: { agent: "c1", since: SINCE },
    moved: { agent: "c1", since: SINCE },
    idle: { agent: "c1", since: SINCE },
    helpers: { agent: "c1", since: SINCE },
  },
});

const { installRenderer } = await import("./support/renderer.ts");
const r = installRenderer();
const { agent, ws } = await import("./support/fixtures.ts");
const agents = await import("../src/agents/model.ts");

const head = (w: Workspace): string => agents.headStatus(w.agents?.[0] ?? null, w);
const scene = (id: string, status: AgentStatus, extra: Partial<Agent> = {}): Workspace =>
  ws(id, { agents: [agent(status, { id: "c1", sinceEpoch: NOW - 42 * 60, lastActivityAt: SINCE, ...extra })] });

describe("a quiet agent", () => {
  beforeEach(() => {
    r.data.epoch = NOW;
    r.data.selectedId = null;
  });

  it("says how long it has been quiet, from the core's verdict and the panel's clock", () => {
    assert.equal(head(scene("quiet", "working")), "Working 42m · quiet 17m");
    r.data.epoch = NOW + 5 * 60;
    assert.equal(head(scene("quiet", "working")), "Working 47m · quiet 22m");
  });

  it("stays plain working with no verdict, as with the Cockpit closed", () => {
    assert.equal(head(scene("none", "working")), "Working 42m");
  });

  it("drops a verdict about another agent", () => {
    assert.equal(head(scene("other", "working", { id: "c2" })), "Working 42m");
  });

  it("drops a verdict the agent has shown activity since", () => {
    assert.equal(head(scene("moved", "working", { lastActivityAt: NOW - 60 })), "Working 42m");
  });

  it("drops a verdict once the agent is not working", () => {
    assert.equal(head(scene("idle", "idle", { sinceEpoch: NOW - 60 })), "Idle 1m");
    assert.equal(head(scene("idle", "needs_input", { sinceEpoch: NOW - 60 })).includes("quiet"), false);
  });

  it("follows the verdict, not the helpers the panel can see (#425)", () => {
    // The core counts the chat's runs from before a /clear too, which the
    // panel cannot see; its verdict stands whatever the rows show.
    const w = scene("helpers", "working", {
      children: [{ id: "h1", label: "explore", running: true, startedEpoch: NOW - 60 }],
    });
    assert.equal(head(w), "Working 42m · quiet 17m");
  });
});
