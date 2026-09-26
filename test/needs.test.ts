import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { installRenderer } from "./support/renderer.ts";

const r = installRenderer();
const { agent, ws } = await import("./support/fixtures.ts");
const needs = await import("../src/shared/needs.ts");
const agents = await import("../src/agents/model.ts");
const status = await import("../src/cockpit/status.ts");

// A Claude turn that ended at `ended`, then flagged needs_input at `flagged`.
const claude = (ended: number, flagged: number) =>
  agent("needs_input", { kind: "claude", lastActivityAt: ended, sinceEpoch: flagged });

beforeEach(() => {
  r.data.epoch = 10_000;
  r.data.workspaces = [];
});

describe("isIdleNudge", () => {
  it("reads a needs_input a minute after the last activity as the idle nudge", () => {
    assert.equal(needs.isIdleNudge(claude(1000, 1060)), true);
    assert.equal(needs.isIdleNudge(claude(1000, 1000 + needs.NUDGE_GAP)), true);
  });

  it("keeps a real ask that follows the agent's activity", () => {
    assert.equal(needs.isIdleNudge(claude(1000, 1002)), false);
    assert.equal(needs.isIdleNudge(claude(1000, 1000 + needs.NUDGE_GAP - 1)), false);
  });

  it("closes the gap when the workspace's latest message is newer", () => {
    const w = ws("w", { latestAt: 1058 });
    assert.equal(needs.isIdleNudge(claude(1000, 1060), w), false);
  });

  it("fails towards needs you when a timestamp is missing or the agent is not Claude", () => {
    assert.equal(needs.isIdleNudge(agent("needs_input", { kind: "claude", lastActivityAt: 1000 })), false);
    assert.equal(needs.isIdleNudge(agent("needs_input", { kind: "claude", sinceEpoch: 1060 })), false);
    assert.equal(
      needs.isIdleNudge(agent("needs_input", { kind: "codex", lastActivityAt: 1000, sinceEpoch: 1060 })),
      false,
    );
    assert.equal(needs.isIdleNudge(agent("idle", { kind: "claude", lastActivityAt: 1000, sinceEpoch: 1060 })), false);
  });
});

describe("effectiveAgent", () => {
  it("shows a nudge as idle and leaves other agents alone", () => {
    const nudge = claude(1000, 1060);
    assert.equal(needs.effectiveAgent(nudge).status, "idle");
    assert.equal(nudge.status, "needs_input", "the app's object is not mutated");
    const ask = claude(1000, 1001);
    assert.equal(needs.effectiveAgent(ask), ask);
    const busy = agent("working");
    assert.equal(needs.effectiveAgent(busy), busy);
  });

  it("dates a nudge's idle from the end of the turn", () => {
    assert.equal(needs.effectiveAgent(claude(1000, 1060)).sinceEpoch, 1000);
    const byMessage = agent("needs_input", { kind: "claude", sinceEpoch: 1060 });
    const shown = needs.effectiveAgent(byMessage, ws("m", { latestAt: 1000 }));
    assert.equal(shown.status, "idle");
    assert.equal(shown.sinceEpoch, 1060);
  });
});

describe("dismissals", () => {
  it("hide every ask in the workspace until one asks again", () => {
    const w = ws("d", {
      agents: [agent("needs_input", { sinceEpoch: 500 }), agent("needs_input", { sinceEpoch: 600 })],
    });
    assert.equal(needs.isNeedsDismissed(w), false);
    needs.dismissNeeds(w);
    assert.equal(needs.isNeedsDismissed(w), true);
    assert.deepEqual(
      needs.agentsOf(w).map((a) => a.status),
      ["idle", "idle"],
    );
    w.agents = [agent("needs_input", { sinceEpoch: 900 })];
    assert.equal(needs.isNeedsDismissed(w), false);
    assert.equal(needs.agentsOf(w)[0]?.status, "needs_input");
  });

  it("are per workspace and can be restored", () => {
    const a = ws("a", { agents: [agent("needs_input", { sinceEpoch: 500 })] });
    const b = ws("b", { agents: [agent("needs_input", { sinceEpoch: 500 })] });
    needs.dismissNeeds(a);
    assert.equal(needs.isNeedsDismissed(b), false);
    needs.restoreNeeds(a);
    assert.equal(needs.isNeedsDismissed(a), false);
    needs.restoreNeeds(a);
    assert.equal(needs.isNeedsDismissed(a), false);
  });

  it("end with the spell, so a later ask with the same start still shows", () => {
    const asker = agent("needs_input");
    const w = ws("s", { agents: [asker] });
    needs.dismissNeeds(w);
    assert.equal(needs.agentsOf(w)[0]?.status, "idle");
    w.agents = [{ ...asker, status: "working" }];
    needs.agentsOf(w);
    w.agents = [asker];
    assert.equal(needs.agentsOf(w)[0]?.status, "needs_input");
  });

  it("do not hide a second agent that asks after the dismissal", () => {
    const first = agent("needs_input", { sinceEpoch: 500 });
    const w = ws("t", { agents: [first] });
    needs.dismissNeeds(w);
    w.agents = [first, agent("needs_input", { sinceEpoch: 500 })];
    assert.equal(needs.isNeedsDismissed(w), false, "the menu offers Dismiss, not Restore");
    assert.deepEqual(
      needs.agentsOf(w).map((a) => a.status),
      ["idle", "needs_input"],
    );
  });

  it("have nothing to dismiss when the only ask is a nudge", () => {
    const w = ws("n", { agents: [claude(1000, 1060)] });
    needs.dismissNeeds(w);
    assert.equal(needs.isNeedsDismissed(w), false);
  });

  it("ignore a workspace with nothing to dismiss", () => {
    const w = ws("q", { agents: [agent("working")] });
    needs.dismissNeeds(w);
    needs.dismissNeeds(undefined);
    assert.equal(needs.isNeedsDismissed(w), false);
    assert.deepEqual(needs.agentsOf(undefined), []);
  });

  it("dismissNeeds persists the workspace's dismissed asks, restoreNeeds a delete (issue #5)", () => {
    r.opened.length = 0;
    const asker = agent("needs_input", { sinceEpoch: 500 });
    const w = ws("persist-d", { agents: [asker] });
    needs.dismissNeeds(w);
    assert.deepEqual(r.opened, [
      `cmux-cockpit://set?key=dismissed.persist-d&value=${encodeURIComponent(JSON.stringify({ [asker.id]: 500 }))}`,
    ]);

    r.opened.length = 0;
    needs.restoreNeeds(w);
    assert.deepEqual(r.opened, ["cmux-cockpit://set?key=dismissed.persist-d"]);
  });

  it("does not persist anything when there is nothing to dismiss or restore", () => {
    r.opened.length = 0;
    needs.dismissNeeds(ws("empty-persist", { agents: [agent("working")] }));
    needs.dismissNeeds(undefined);
    needs.restoreNeeds(ws("never-dismissed"));
    needs.restoreNeeds(undefined);
    assert.deepEqual(r.opened, []);
  });
});

describe("both sidebars apply the rule", () => {
  it("the agents panel lists a nudge as idle, not waiting", () => {
    r.data.workspaces = [ws("n", { agents: [claude(1000, 1060)] }), ws("real", { agents: [claude(1000, 1001)] })];
    assert.deepEqual(
      agents.waiting().map((e) => e.ws.id),
      ["real"],
    );
    assert.deepEqual(
      agents.roster().idle.map((e) => e.ws.id),
      ["n"],
    );
  });

  it("the agents panel drops a dismissed ask from Waiting on you", () => {
    const w = ws("x", { agents: [agent("needs_input", { sinceEpoch: 700 })] });
    r.data.workspaces = [w];
    needs.dismissNeeds(w);
    assert.deepEqual(agents.waiting(), []);
  });

  it("the cockpit ranks a working agent over a nudge beside it", () => {
    const w = ws("c", { agents: [claude(1000, 1060), agent("working", { lastActivityAt: 900 })] });
    assert.equal(status.statusOf(w), "working");
    assert.equal(status.statusOf(ws("n", { agents: [claude(1000, 1060)] })), "idle");
  });
});
