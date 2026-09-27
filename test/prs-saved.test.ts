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
    green: { ...saved, number: 8, mergeable: true, checks: [{ name: "build", state: "pass" }] },
    // Saved before the poller kept draft or the merge verdict: never ready.
    legacy: { ...saved, number: 13, checks: [{ name: "build", state: "pass" }] },
    draft: { ...saved, number: 9, draft: true, mergeable: true, checks: [{ name: "build", state: "pass" }] },
    draftFailing: { ...saved, number: 14, draft: true },
    draftRunning: { ...saved, number: 15, draft: true, checks: [{ name: "test", state: "pending" }] },
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
const { checksOf, prOf, prSummary, prsOf } = await import("../src/shared/prs.ts");
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

describe("prSummary", () => {
  const at = (id: string) => ws(id, { branch: "feat" });
  const said = (id: string) => {
    const pr = prSummary(at(id));
    return pr ? [pr.health, pr.text] : undefined;
  };

  it("puts a failure first and counts it", () => {
    assert.deepEqual(said("w1"), ["failing", "#7 · 1 failing"]);
  });

  it("says running while a check is pending and none has failed", () => {
    assert.deepEqual(said("running"), ["running", "#10 · running"]);
  });

  it("is ready only when every check passed, GitHub says it can merge and it is out of draft", () => {
    assert.deepEqual(said("green"), ["ready", "#8 · ready"]);
    assert.deepEqual(said("legacy"), ["quiet", "#13"]);
    assert.deepEqual(said("draft"), ["quiet", "#9 · draft"]);
  });

  it("flags an open draft for the chip colour, and nothing else", () => {
    assert.equal(prSummary(at("draft"))?.draft, true);
    assert.equal(prSummary(at("green"))?.draft, false);
  });

  it("keeps a draft's marker in every health, with one separator", () => {
    assert.deepEqual(said("draftFailing"), ["failing", "#14 · draft · 1 failing"]);
    assert.deepEqual(said("draftRunning"), ["running", "#15 · draft · running"]);
  });

  it("stays quiet without checks, and for a PR that is not open", () => {
    assert.deepEqual(said("bare"), ["quiet", "#12"]);
    assert.deepEqual(said("merged"), ["quiet", "#11 · merged"]);
  });

  it("carries the number alone, the status and the link", () => {
    assert.deepEqual(prSummary(at("merged")), {
      number: 11,
      status: "merged",
      url: "https://github.com/o/r/pull/7",
      health: "quiet",
      draft: false,
      tag: "#11",
      text: "#11 · merged",
    });
  });

  it("has nothing to say without a numbered PR", () => {
    assert.equal(prSummary(undefined), undefined);
    assert.equal(prSummary(ws("none")), undefined);
    assert.equal(prSummary(ws("n", { pr: { url: "https://github.com/o/r/pull/1" } })), undefined);
    assert.deepEqual(prSummary(ws("c", { pr: { number: 3 } })), {
      number: 3,
      status: undefined,
      url: undefined,
      health: "quiet",
      draft: false,
      tag: "#3",
      text: "#3",
    });
  });
});
