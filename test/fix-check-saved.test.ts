// Fix on a failed check: it types a prompt into the agent's terminal and
// presses Enter, so it shows only while that agent can take typing (idle, or
// its turn), never while it works or asks, since the words would answer a
// permission prompt. __STATE__ is set before the renderer import, as in
// asking-saved.test.ts.

import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

const checks = [
  { name: "lint", state: "fail" },
  { name: "build", state: "pending" },
  { name: "test", state: "pass" },
];
const pr = (n: number) => ({ number: n, url: "https://github.com/o/r/pull/" + n, status: "open", branch: "b", checks });

(globalThis as Record<string, unknown>).__STATE__ = {
  dismissed: {},
  projectOverride: {},
  projects: {},
  prs: { sel: pr(7), asked: pr(8) },
  ownPrs: {},
  subagents: {},
  published: {},
  asking: { asked: { reason: "allow git push?", epoch: 1000 } },
  ui: {},
};

const { installRenderer } = await import("./support/renderer.ts");
const r = installRenderer();
const { agent, ws } = await import("./support/fixtures.ts");
const m = await import("../src/agents/model.ts");
const { dismissNeeds } = await import("../src/shared/needs.ts");

let epoch = 1060;

beforeEach(() => {
  // Each test moves the clock on so the last one's optimistic state expires.
  epoch += 1000;
  r.data.epoch = epoch;
  r.data.workspaces = [];
  r.calls.length = 0;
});

const select = (id: string, a: Agent) => {
  r.data.workspaces = [ws(id, { selected: true, agents: [a] })];
};

const failed = () => m.checks().filter((c) => c.state === "fail");

const fixable = () =>
  m
    .checks()
    .filter(m.canFix)
    .map((c) => c.name);

describe("fixPrompt", () => {
  it("names the check and the PR, and says how to read the log", () => {
    assert.equal(
      m.fixPrompt("lint", 7),
      "The lint check failed on PR #7. Find its run with gh pr checks 7, read the log with " +
        "gh run view <run-id> --log-failed, fix the cause, push, and tell me what it was.",
    );
  });
});

describe("when Fix shows", () => {
  it("shows on the failed check only, while the agent is idle", () => {
    select("sel", agent("idle", { surfaceId: "s1", sinceEpoch: 900 }));
    assert.deepEqual(fixable(), ["lint"]);
  });

  it("shows on its turn: needs_input with no fresh ask", () => {
    select("sel", agent("needs_input", { surfaceId: "s1", sinceEpoch: 1050 }));
    assert.deepEqual(fixable(), ["lint"]);
  });

  it("hides while the agent works, has ended, or has no terminal", () => {
    select("sel", agent("working", { surfaceId: "s1", sinceEpoch: 900 }));
    assert.deepEqual(fixable(), []);
    select("sel", agent("ended", { surfaceId: "s1", sinceEpoch: 900 }));
    assert.deepEqual(fixable(), []);
    select("sel", agent("idle", { sinceEpoch: 900 }));
    assert.deepEqual(fixable(), []);
  });

  it("hides while the agent asks", () => {
    select("asked", agent("needs_input", { surfaceId: "s1", sinceEpoch: 990 }));
    assert.deepEqual(fixable(), []);
  });

  it("stays hidden after the ask is dismissed: the prompt is still on screen", () => {
    select("asked", agent("needs_input", { surfaceId: "s1", sinceEpoch: 990 }));
    dismissNeeds(r.data.workspaces?.[0]);
    assert.notEqual(m.cur().a?.status, "needs_input", "the panel shows the dismissed ask as not asking");
    assert.deepEqual(fixable(), []);
  });

  it("hides on needs_input without a start time, which could be an ask", () => {
    select("sel", agent("needs_input", { surfaceId: "s1" }));
    assert.deepEqual(fixable(), []);
  });

  it("hides with no agent", () => {
    r.data.workspaces = [ws("sel", { selected: true })];
    assert.equal(failed().length, 1);
    assert.deepEqual(fixable(), []);
  });
});

describe("sendFix", () => {
  it("types the prompt into the agent's terminal, then presses Enter", () => {
    select("sel", agent("idle", { surfaceId: "s1", sinceEpoch: 900 }));
    m.sendFix("lint");
    assert.deepEqual(r.calls, [
      {
        method: "surface.send_text",
        params: { workspace_id: "sel", surface_id: "s1", text: m.fixPrompt("lint", 7) },
      },
      { method: "surface.send_key", params: { workspace_id: "sel", surface_id: "s1", key: "enter" } },
    ]);
  });

  it("hides Fix until the agent's status changes, so a second tap sends nothing", () => {
    const a = agent("idle", { surfaceId: "s1", sinceEpoch: 900 });
    select("sel", a);
    m.sendFix("lint");
    assert.deepEqual(fixable(), []);
    m.sendFix("lint");
    assert.equal(r.calls.length, 2);
    // The agent works, then finishes: a new spell brings Fix back.
    select("sel", { ...a, status: "working", sinceEpoch: 950 });
    assert.deepEqual(fixable(), []);
    select("sel", { ...a, status: "idle", sinceEpoch: 1000 });
    assert.deepEqual(fixable(), ["lint"]);
  });

  it("sends nothing while the agent works", () => {
    select("sel", agent("working", { surfaceId: "s1", sinceEpoch: 900 }));
    m.sendFix("lint");
    assert.deepEqual(r.calls, []);
  });
});
