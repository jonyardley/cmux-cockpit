// Asking or your turn (issue #81), from the saved asks the notification hook
// writes: a needs_input that began with a fresh ask reads amber "Asking" with
// its reason, and one that began after it (the agent went back to work and
// finished) reads clay "Your turn". __STATE__ is set before the renderer
// import, as in subagents-saved.test.ts.

import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

(globalThis as Record<string, unknown>).__STATE__ = {
  dismissed: {},
  projectOverride: {},
  projects: {},
  prs: {},
  ownPrs: {},
  subagents: {},
  published: {},
  asking: {
    wA: { reason: "allow git push?", epoch: 1000, session: "s1" },
    sel: { reason: "Which layout?", epoch: 1000 },
    owned: { reason: "allow npm publish?", epoch: 1500, session: "sessA" },
  },
  ui: {},
};

const { installRenderer } = await import("./support/renderer.ts");
const r = installRenderer();
const { agent, ws } = await import("./support/fixtures.ts");
const needs = await import("../src/shared/needs.ts");
const { HOOK_SLACK } = await import("../src/shared/saved.ts");
const m = await import("../src/agents/model.ts");
const { T } = await import("../src/agents/theme.ts");

// An agent that went needs_input at `since`, its turn having worked until then.
const waiting = (since: number, extra: Partial<Agent> = {}) =>
  agent("needs_input", { sinceEpoch: since, lastActivityAt: since, ...extra });

beforeEach(() => {
  r.data.epoch = 1060;
  r.data.workspaces = [];
});

describe("askReason", () => {
  it("is the saved reason while the ask is at least as new as the spell", () => {
    const w = ws("wA");
    assert.equal(needs.askReason(waiting(1000), w), "allow git push?");
    assert.equal(needs.askReason(waiting(990), w), "allow git push?", "an ask heard after the spell began");
    assert.equal(needs.askReason(waiting(1000 + HOOK_SLACK), w), "allow git push?", "within the slack");
  });

  it("is null once the spell began after the ask: the agent worked again and finished", () => {
    assert.equal(needs.askReason(waiting(1001 + HOOK_SLACK), ws("wA")), null);
  });

  it("is null without a saved ask, a start time, a needs_input or an agent", () => {
    assert.equal(needs.askReason(waiting(1000), ws("other")), null);
    assert.equal(needs.askReason(agent("needs_input"), ws("wA")), null);
    assert.equal(needs.askReason(agent("working", { sinceEpoch: 1000 }), ws("wA")), null);
    assert.equal(needs.askReason(null, ws("wA")), null);
    assert.equal(needs.askReason(waiting(1000), undefined), null);
  });

  it("gives the ask only to the agent whose id is the asking session, when one has it", () => {
    const asker = agent("needs_input", { id: "sessA", sinceEpoch: 1500 });
    const finished = agent("needs_input", { id: "sessB", sinceEpoch: 1000 });
    const w = ws("owned", { agents: [asker, finished] });
    assert.equal(needs.askReason(asker, w), "allow npm publish?");
    assert.equal(needs.askReason(finished, w), null, "another agent's turn end never borrows the reason");
    // No agent carries the session as its id: the ask is the workspace's.
    const loose = agent("needs_input", { id: "other", sinceEpoch: 1500 });
    assert.equal(needs.askReason(loose, ws("owned", { agents: [loose] })), "allow npm publish?");
  });

  it("reads a fresh ask as an ask even after a long quiet spell, and an older one as the nudge", () => {
    const quiet = agent("needs_input", { kind: "claude", lastActivityAt: 900, sinceEpoch: 1000 });
    const w = ws("wA", { agents: [quiet] });
    assert.equal(needs.isIdleNudge(quiet, w), false);
    assert.equal(needs.askReason(needs.agentsOf(w)[0], w), "allow git push?");
  });

  it("never reads a nudge or a dismissal as an ask, once the agent is as the sidebars show it", () => {
    const nudge = agent("needs_input", { kind: "claude", lastActivityAt: 1000, sinceEpoch: 1100 });
    const w = ws("wA", { agents: [nudge] });
    assert.equal(needs.askReason(needs.agentsOf(w)[0], w), null);
    const asker = waiting(1000);
    const d = ws("wA", { agents: [asker] });
    needs.dismissNeeds(d);
    assert.equal(needs.askReason(needs.agentsOf(d)[0], d), null);
  });
});

describe("agents panel", () => {
  it("heads an asking workspace amber, with its reason over the buttons", () => {
    const asker = waiting(1000, { surfaceId: "s" });
    r.data.workspaces = [ws("sel", { selected: true, agents: [asker], latestMessage: "I will push now." })];
    assert.equal(m.headStatus(asker), "Asking 1m");
    assert.equal(m.statusLine(asker), "asking 1m");
    assert.equal(m.dotFor(asker), T.amber);
    assert.equal(m.haloFor(asker), T.amberHalo);
    assert.equal(m.statusColor(asker), T.amberText);
    assert.equal(m.currentAsk()?.text, "Which layout?");
  });

  it("keeps a finished turn clay and says it is your turn", () => {
    const done = waiting(1100);
    r.data.epoch = 1110;
    r.data.workspaces = [ws("sel", { selected: true, agents: [done], latestMessage: "All green." })];
    assert.equal(m.headStatus(done), "Your turn <1m");
    assert.equal(m.statusLine(done), "your turn <1m");
    assert.equal(m.dotFor(done), T.clay);
    assert.equal(m.haloFor(done), T.clayHalo);
    assert.equal(m.statusColor(done), T.clayText);
    assert.equal(m.currentAsk()?.text, "All green.");
  });

  it("colours agents that are not asking by their status, and no agent grey", () => {
    r.data.workspaces = [ws("sel", { selected: true, agents: [agent("working")] })];
    assert.equal(m.dotFor(agent("working")), T.blue);
    assert.equal(m.statusColor(agent("idle")), T.metaText);
    assert.equal(m.dotFor(null), T.grey);
    assert.equal(m.statusColor(null), T.secondary);
    assert.equal(m.haloFor(null), "clear");
  });
});
