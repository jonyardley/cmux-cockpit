// Merged PRs tidy themselves up (merged.ts): a merged card dims and offers
// Close workspace and Keep, and Keep hides them for good. __STATE__ is set
// before the renderer import, as in automove.test.ts, so a Keep saved
// before the last reload holds.

import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { emptyState, type SavedPr, type State } from "../scripts/state-config.ts";

const base: SavedPr = { number: 1, url: "https://github.com/o/r/pull/1", status: "open", branch: "feat" };
const merged: SavedPr = { ...base, status: "merged" };

const seeded: State = {
  ...emptyState(),
  prs: { done: merged, open: base, saved: merged, kept: merged, closes: merged, anchor: merged, picked: merged },
  mergeKept: { saved: 100 },
};
(globalThis as Record<string, unknown>).__STATE__ = seeded;

const { installRenderer } = await import("./support/renderer.ts");
const r = installRenderer();
const { group, ws } = await import("./support/fixtures.ts");
const m = await import("../src/cockpit/merged.ts");

const closes = () => r.calls.filter((c) => c.method === "workspace.close").map((c) => c.params.workspace_id);
const saves = () => r.opened.map((u) => decodeURIComponent(u).match(/key=([^&]+)&value=(\d+)/)?.[1]);

describe("merged cards", () => {
  beforeEach(() => {
    r.data.epoch += 100;
    r.data.groups = [group("g-parked", "Parked", { anchorId: "anchor" })];
    r.calls.length = 0;
    r.opened.length = 0;
  });

  it("reads merged from the PR, not from an open or missing one", () => {
    assert.equal(m.isMerged(ws("done")), true);
    assert.equal(m.isMerged(ws("open")), false);
    assert.equal(m.isMerged(ws("none")), false);
    assert.equal(m.isMerged(undefined), false);
  });

  it("dims a merged card, but not once it is selected", () => {
    assert.equal(m.cardOpacity(ws("done")), m.MERGED_OPACITY);
    assert.equal(m.cardOpacity(ws("picked", { selected: true })), 1, "a selected card reads at full strength");
    assert.equal(m.cardOpacity(ws("open")), 1);
  });

  it("offers the buttons on a merged card only, and never on a group's anchor", () => {
    assert.equal(m.offersMergedActions(ws("done")), true);
    assert.equal(m.offersMergedActions(ws("open")), false);
    assert.equal(m.offersMergedActions(ws("anchor")), false, "closing it would take the lane's anchor");
    assert.equal(m.offersMergedActions(undefined), false);
  });

  it("holds a Keep saved before the last reload", () => {
    assert.equal(m.offersMergedActions(ws("saved")), false);
    assert.equal(m.cardOpacity(ws("saved")), m.MERGED_OPACITY, "kept cards stay dimmed");
  });

  it("Keep hides the buttons at once and saves it, once", () => {
    m.keepMerged(ws("kept"));
    assert.equal(m.offersMergedActions(ws("kept")), false);
    assert.deepEqual(saves(), ["mergeKept.kept"]);
    m.keepMerged(ws("kept"));
    m.keepMerged(undefined);
    assert.equal(r.opened.length, 1, "a second tap writes nothing");
  });

  it("Close workspace closes a merged card's workspace, and nothing else", () => {
    m.closeMerged(ws("closes"));
    assert.deepEqual(closes(), ["closes"]);
    for (const w of [ws("open"), ws("saved"), ws("anchor"), undefined]) m.closeMerged(w);
    assert.deepEqual(closes(), ["closes"], "only a card that offers the button closes");
  });
});
