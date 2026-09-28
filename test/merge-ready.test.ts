// A lane header's "N ready to merge": its cards whose saved PR GitHub would
// merge now. __STATE__ is set before the renderer import, as in
// prs-saved.test.ts, since the saved PRs are read once at load.

import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

const pass = [{ name: "build", state: "pass" }];
const open = { url: "https://github.com/o/r/pull/1", status: "open", branch: "feat", checks: pass };
(globalThis as Record<string, unknown>).__STATE__ = {
  dismissed: {},
  projectOverride: {},
  projects: {},
  prs: {
    ready1: { ...open, number: 1, mergeable: true },
    ready2: { ...open, number: 2, mergeable: true },
    draft: { ...open, number: 3, mergeable: true, draft: true },
    failing: { ...open, number: 4, mergeable: true, checks: [{ name: "build", state: "fail" }] },
    merged: { ...open, number: 5, mergeable: true, status: "merged" },
    readyMain: { ...open, number: 6, mergeable: true },
  },
  ownPrs: {},
  ui: {},
};

const { installRenderer } = await import("./support/renderer.ts");
const r = installRenderer();
const { group, ws } = await import("./support/fixtures.ts");
const model = await import("../src/cockpit/model.ts");

function setup(): void {
  r.data.epoch += 100;
  r.data.groups = [
    group("g-main", "Main activity", { anchorId: "anchor-main" }),
    group("g-review", "For review", { anchorId: "anchor-review" }),
  ];
  r.data.workspaces = [
    ws("anchor-main", { title: "Main activity", group: "g-main" }),
    ws("readyMain", { group: "g-main" }),
    ws("anchor-review", { title: "For review", group: "g-review" }),
    ws("ready1", { group: "g-review" }),
    ws("ready2", { group: "g-review" }),
    ws("draft", { group: "g-review" }),
    ws("failing", { group: "g-review" }),
    ws("merged", { group: "g-review" }),
  ];
}

describe("mergeReadyText", () => {
  beforeEach(setup);

  it("counts only the lane's PRs that are out of draft, passing and mergeable", () => {
    assert.equal(model.mergeReadyText("review"), "2 ready to merge");
  });

  it("counts each lane on its own", () => {
    assert.equal(model.mergeReadyText("main"), "1 ready to merge");
  });

  it("says nothing when no PR in the lane is ready", () => {
    assert.equal(model.mergeReadyText("parked"), "");
  });

  it("drops a card once it has moved to another branch", () => {
    const w = r.data.workspaces.find((x) => x.id === "ready2");
    if (w) w.branch = "other";
    assert.equal(model.mergeReadyText("review"), "1 ready to merge");
  });
});
