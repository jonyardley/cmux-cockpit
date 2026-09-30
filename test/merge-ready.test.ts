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
    conflicts: { ...open, number: 7, mergeable: true, conflicts: true },
    running: { ...open, number: 8, mergeable: true, checks: [{ name: "build", state: "pending" }] },
    noVerdict: { ...open, number: 9 },
    blocked: { ...open, number: 10, mergeable: false },
    noChecks: { ...open, number: 11, mergeable: true, checks: [] },
    "anchor-parked": { ...open, number: 12, mergeable: true },
  },
  ownPrs: {},
  ui: {},
};

const { installRenderer } = await import("./support/renderer.ts");
const r = installRenderer();
const { agent, group, ws } = await import("./support/fixtures.ts");
const model = await import("../src/cockpit/model.ts");
const { C } = await import("../src/cockpit/theme.ts");
const { READY_INK } = await import("../src/shared/pr-colors.ts");

// WCAG relative luminance of a #RRGGBB colour, and the contrast ratio of two.
const luminance = (hex: string): number => {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (b ?? 0);
};
const contrast = (a: string, b: string): number => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return ((hi ?? 0) + 0.05) / ((lo ?? 0) + 0.05);
};

function setup(): void {
  r.data.epoch += 100;
  r.data.groups = [
    group("g-main", "Main activity", { anchorId: "anchor-main" }),
    group("g-review", "For review", { anchorId: "anchor-review" }),
    group("g-bg", "Background", { anchorId: "anchor-bg" }),
    group("g-parked", "Parked", { anchorId: "anchor-parked" }),
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
    ws("anchor-bg", { title: "Background", group: "g-bg" }),
    ws("conflicts", { group: "g-bg" }),
    ws("running", { group: "g-bg" }),
    ws("noVerdict", { group: "g-bg" }),
    ws("blocked", { group: "g-bg" }),
    ws("noChecks", { group: "g-bg" }),
    // A generated anchor has no card; its PR still counts on the header.
    ws("anchor-parked", { title: "Parked", group: "g-parked" }),
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

  it("says nothing when the lane's PRs are in conflict, running, blocked, without a verdict or without checks", () => {
    assert.equal(model.mergeReadyText("bg"), "");
  });

  it("says nothing for a lane with no workspaces", () => {
    assert.equal(model.mergeReadyText("unsorted"), "");
  });

  it("counts the lane's generated anchor, which has no card of its own", () => {
    assert.equal(model.mergeReadyText("parked"), "1 ready to merge");
  });

  it("still counts a card the Needs you strip lists: a waiting session's PR is still mergeable", () => {
    const w = r.data.workspaces.find((x) => x.id === "readyMain");
    if (w) w.agents = [agent("needs_input", { sinceEpoch: r.data.epoch - 30 })];
    assert.ok(model.needsShown().some((x) => x.id === "readyMain"));
    assert.ok(model.flatEntries().some((e) => e.kind === "ghost" && e.wsId === "readyMain"));
    assert.equal(model.mergeReadyText("main"), "1 ready to merge");
  });

  it("drops a card once it has moved to another branch", () => {
    const w = r.data.workspaces.find((x) => x.id === "ready2");
    if (w) w.branch = "other";
    assert.equal(model.mergeReadyText("review"), "1 ready to merge");
  });
});

describe("headerHint", () => {
  beforeEach(setup);

  it("says Drop here while a drag is over the lane, whatever is ready", () => {
    assert.deepEqual(model.headerHint("review", true), { text: "Drop here", color: C.heading });
  });

  it("gives the merge line in ready's green, not the agent's Ready green", () => {
    const hint = model.headerHint("review", false);
    assert.equal(hint.text, "2 ready to merge");
    assert.equal(hint.color, READY_INK);
    // Different hex is not enough: the two share a hue, so hold a real
    // lightness gap (a contrast ratio between them) or they read as one.
    assert.ok(contrast(hint.color, C.greenText) >= 1.5);
  });

  it("keeps Parked's merge line faint", () => {
    assert.deepEqual(model.headerHint("parked", false), { text: "1 ready to merge", color: C.faint });
  });
});
