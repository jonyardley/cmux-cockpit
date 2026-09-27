// A workspace's PR from the saved state (#7): cmux sends custom sidebars no
// PR data, so the one scripts/pr-poll.ts saved shows instead, and cmux's own
// wins the day it sends any. __STATE__ is set before the renderer import, as
// in state-seed.test.ts.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

const saved = { number: 7, url: "https://github.com/o/r/pull/7", status: "open", branch: "feat" };
(globalThis as Record<string, unknown>).__STATE__ = {
  dismissed: {},
  projectOverride: {},
  projects: {},
  prs: { w1: saved },
};

const { installRenderer } = await import("./support/renderer.ts");
const r = installRenderer();
const { ws } = await import("./support/fixtures.ts");
const { prOf, prsOf } = await import("../src/shared/prs.ts");
const agents = await import("../src/agents/model.ts");

describe("prsOf", () => {
  it("shows the saved PR while the workspace is on its branch", () => {
    assert.deepEqual(prsOf(ws("w1", { branch: "feat" })), [saved]);
    assert.deepEqual(prOf(ws("w1", { branch: "feat" })), saved);
  });

  it("hides it once the workspace has moved to another branch", () => {
    assert.deepEqual(prsOf(ws("w1", { branch: "main" })), []);
  });

  it("shows it while the workspace's branch is not yet known", () => {
    assert.deepEqual(prsOf(ws("w1")), [saved]);
  });

  it("prefers cmux's own PRs, list first", () => {
    const own = { number: 9, url: "https://github.com/o/r/pull/9" };
    assert.deepEqual(prsOf(ws("w1", { branch: "feat", pr: own })), [own]);
    assert.deepEqual(prsOf(ws("w1", { branch: "feat", prs: [own, saved] })), [own, saved]);
  });

  it("has nothing for an unknown workspace", () => {
    assert.equal(prOf(ws("w2", { branch: "feat" })), undefined);
    assert.equal(prOf(undefined), undefined);
  });
});

describe("the agents panel's Pull requests list", () => {
  it("lists the saved PR", () => {
    r.data.workspaces = [ws("w1", { branch: "feat" })];
    r.data.epoch++;
    assert.deepEqual(
      agents.prs().map((e) => e.pr.number),
      [7],
    );
  });
});
