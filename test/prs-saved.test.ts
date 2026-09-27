// A workspace's PR from the saved state (#7): cmux sends custom sidebars no
// PR data, so the one scripts/pr-poll.ts saved shows instead, and cmux's own
// wins the day it sends any. __STATE__ is set before the renderer import, as
// in state-seed.test.ts.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

const checks = [
  { name: "lint", state: "fail" },
  { name: "test", state: "pending" },
  { name: "build", state: "pass" },
];
const saved = { number: 7, url: "https://github.com/o/r/pull/7", status: "open", branch: "feat", checks };
(globalThis as Record<string, unknown>).__STATE__ = {
  dismissed: {},
  projectOverride: {},
  projects: {},
  prs: {
    w1: saved,
    green: { ...saved, number: 8, checks: [{ name: "build", state: "pass" }] },
    draft: { ...saved, number: 9, draft: true, checks: [{ name: "build", state: "pass" }] },
    running: {
      ...saved,
      number: 10,
      checks: [
        { name: "build", state: "pass" },
        { name: "test", state: "pending" },
      ],
    },
    merged: { ...saved, number: 11, status: "merged", checks },
    bare: { number: 12, url: "https://github.com/o/r/pull/12", status: "open", branch: "feat" },
  },
};

const { installRenderer } = await import("./support/renderer.ts");
const r = installRenderer();
const { ws } = await import("./support/fixtures.ts");
const { checksOf, prChipText, prHealth, prOf, prsOf } = await import("../src/shared/prs.ts");
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

describe("checksOf", () => {
  it("gives the saved PR's checks while it shows", () => {
    assert.deepEqual(checksOf(ws("w1", { branch: "feat" })), checks);
    assert.deepEqual(checksOf(ws("w1")), checks);
  });

  it("has none once the branch moves, when cmux sends its own PR, or for an unknown workspace", () => {
    assert.deepEqual(checksOf(ws("w1", { branch: "main" })), []);
    assert.deepEqual(checksOf(ws("w1", { branch: "feat", pr: { number: 9 } })), []);
    assert.deepEqual(checksOf(ws("w2")), []);
  });
});

describe("the agents panel's Checks block", () => {
  it("lists the selected workspace's checks with passed over total", () => {
    r.data.workspaces = [ws("w1", { branch: "feat", selected: true })];
    r.data.epoch++;
    const rows = agents.checks();
    assert.deepEqual(
      rows.map((c) => [c.name, agents.checkWord(c), agents.checkDot(c)]),
      [
        ["lint", "failed", "#C0453A"],
        ["test", "running", "#3B6FB6"],
        ["build", "passed", "#788C5D"],
      ],
    );
    assert.equal(agents.checksFigure(rows), "1 / 3");
    assert.equal(new Set(rows.map((c) => c.key)).size, 3);
  });

  it("is empty when nothing is selected", () => {
    r.data.workspaces = [ws("w1", { branch: "feat" })];
    r.data.epoch++;
    assert.deepEqual(agents.checks(), []);
    assert.equal(agents.checksFigure([]), "0 / 0");
  });
});

describe("prHealth and prChipText", () => {
  const at = (id: string) => ws(id, { branch: "feat" });

  it("puts a failure first and counts it", () => {
    assert.equal(prHealth(at("w1")), "failing");
    assert.equal(prChipText(at("w1")), "#7 · 1 failing");
  });

  it("says running while a check is pending and none has failed", () => {
    assert.equal(prHealth(at("running")), "running");
    assert.equal(prChipText(at("running")), "#10 · running");
  });

  it("is ready only when every check passed and the PR is out of draft", () => {
    assert.equal(prHealth(at("green")), "ready");
    assert.equal(prChipText(at("green")), "#8 · ready");
    assert.equal(prHealth(at("draft")), "quiet");
    assert.equal(prChipText(at("draft")), "#9 draft");
  });

  it("stays quiet without checks, and for a PR that is not open", () => {
    assert.equal(prHealth(at("bare")), "quiet");
    assert.equal(prChipText(at("bare")), "#12");
    assert.equal(prHealth(at("merged")), "quiet");
    assert.equal(prChipText(at("merged")), "#11 merged");
  });

  it("has nothing to say without a PR", () => {
    assert.equal(prHealth(undefined), "quiet");
    assert.equal(prChipText(undefined), "");
    assert.equal(prChipText(ws("none")), "");
    assert.equal(prChipText(ws("n", { pr: { url: "https://github.com/o/r/pull/1" } })), "");
    assert.equal(prChipText(ws("c", { pr: { number: 3 } })), "#3");
  });
});
