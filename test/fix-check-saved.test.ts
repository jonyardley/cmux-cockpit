// Fix on a failed check: it sends the agent a cmux agent message, which
// waits while the agent works or a prompt is open and is never typed, so it
// shows for any live agent. __STATE__ is set before the renderer import, as
// in asking-saved.test.ts.

import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

const checks = [
  { name: "lint", state: "fail" },
  { name: "build", state: "pending" },
  { name: "test", state: "pass" },
];
const pr = (n: number, status = "open") => ({
  number: n,
  url: "https://github.com/o/r/pull/" + n,
  status,
  branch: "b",
  checks,
});

(globalThis as Record<string, unknown>).__STATE__ = {
  dismissed: {},
  projectOverride: {},
  projects: {},
  prs: { sel: pr(7), asked: pr(8), merged: pr(10, "merged") },
  ownPrs: {},
  subagents: {},
  published: {},
  asking: { asked: { reason: "allow git push?", epoch: 1000 } },
  poll: { okEpoch: 1000 },
  ui: {},
};

const { installRenderer } = await import("./support/renderer.ts");
const r = installRenderer();
const { agent, ws } = await import("./support/fixtures.ts");
const m = { ...(await import("../src/agents/model.ts")), ...(await import("../src/agents/checks.ts")) };

beforeEach(() => {
  r.data.epoch = 1100;
  r.data.workspaces = [];
  r.calls.length = 0;
});

const select = (id: string, a: Agent, extra: Partial<Workspace> = {}) => {
  r.data.workspaces = [ws(id, { selected: true, agents: [a], ...extra })];
};

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

  it("shows while the agent works: the message waits for its next step", () => {
    select("sel", agent("working", { surfaceId: "s1", sinceEpoch: 900 }));
    assert.deepEqual(fixable(), ["lint"]);
  });

  it("shows while the agent asks: the message waits for the prompt to close", () => {
    select("asked", agent("needs_input", { surfaceId: "s1", sinceEpoch: 990 }));
    assert.deepEqual(fixable(), ["lint"]);
    select("sel", agent("needs_input", { surfaceId: "s1", sinceEpoch: 1050 }));
    assert.deepEqual(fixable(), ["lint"]);
  });

  it("shows with no terminal surface: the message goes to the workspace", () => {
    select("sel", agent("idle", { sinceEpoch: 900 }));
    assert.deepEqual(fixable(), ["lint"]);
  });

  it("hides once the agent has ended", () => {
    select("sel", agent("ended", { surfaceId: "s1", sinceEpoch: 900 }));
    assert.deepEqual(fixable(), []);
  });

  it("hides with no agent", () => {
    r.data.workspaces = [ws("sel", { selected: true })];
    assert.equal(m.checks().filter((c) => c.state === "fail").length, 1);
    assert.deepEqual(fixable(), []);
  });

  it("hides on a merged PR, and while the checks are stale", () => {
    select("merged", agent("idle", { surfaceId: "s1", sinceEpoch: 900 }));
    assert.equal(m.checks().filter((c) => c.state === "fail").length, 1);
    assert.deepEqual(fixable(), []);
    select("sel", agent("idle", { surfaceId: "s1", sinceEpoch: 900 }));
    r.data.epoch = 1000 + 15 * 60 + 1;
    assert.deepEqual(fixable(), []);
  });
});

describe("sendFix", () => {
  const sent = (target: string, pr: number) => ({
    method: "agent.message.send",
    params: { target, body: m.fixPrompt("lint", pr), from: "cockpit" },
  });

  for (const status of ["idle", "working", "needs_input"] as const) {
    it(`sends one agent message to the workspace, typing nothing, while ${status}`, () => {
      select("sel", agent(status, { surfaceId: "s1", sinceEpoch: 1050 }));
      m.sendFix("lint");
      assert.deepEqual(r.calls, [sent("sel", 7)]);
    });
  }

  it("hides Fix until the agent's status changes, so a second tap sends nothing", () => {
    const a = agent("idle", { surfaceId: "s1", sinceEpoch: 900 });
    select("sel", a);
    m.sendFix("lint");
    assert.deepEqual(fixable(), []);
    m.sendFix("lint");
    assert.equal(r.calls.length, 1);
    // Activity alone does not end the hold before the agent starts working.
    select("sel", { ...a, lastActivityAt: 1101 });
    assert.deepEqual(fixable(), []);
    // The agent wakes to the message: a new spell brings Fix back.
    select("sel", { ...a, status: "working", sinceEpoch: 1102 });
    assert.deepEqual(fixable(), ["lint"]);
  });

  it("brings Fix back after the 90 second hold when the spell never changes", () => {
    // A busy agent stays working with the same start time: only the clock ends it.
    select("sel", agent("working", { surfaceId: "s1", sinceEpoch: 900 }));
    m.sendFix("lint");
    assert.deepEqual(fixable(), []);
    r.data.epoch = 1100 + 89;
    assert.deepEqual(fixable(), []);
    r.data.epoch = 1100 + 90;
    assert.deepEqual(fixable(), ["lint"]);
  });

  it("sends nothing once the agent has ended", () => {
    select("sel", agent("ended", { surfaceId: "s1", sinceEpoch: 900 }));
    m.sendFix("lint");
    assert.deepEqual(r.calls, []);
  });
});
