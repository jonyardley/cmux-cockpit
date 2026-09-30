// Merged PRs tidy themselves up (merged.ts): a merged card dims and offers
// Park and Close, with Keep in the card menu, which hides them for that PR. __STATE__ is
// set before the renderer import, as in prs-saved.test.ts, so a Keep saved
// before the last reload holds.

import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { emptyState, type SavedPr, type State } from "../scripts/state-config.ts";

const base: SavedPr = { number: 1, url: "https://github.com/o/r/pull/1", status: "open", branch: "feat" };
const merged: SavedPr = { ...base, status: "merged" };
const later: SavedPr = { ...merged, number: 2, url: "https://github.com/o/r/pull/2" };

const seeded: State = {
  ...emptyState(),
  prs: {
    done: merged,
    open: base,
    saved: merged,
    moved: later,
    kept: merged,
    closes: merged,
    anchor: merged,
    busy: merged,
    parks: merged,
    inParked: merged,
    pinKept: merged,
  },
  mergeKept: { saved: 1, moved: 1 },
};
// globalThis has no __STATE__ property in its type; the bundle's build
// defines it, so a test sets it by name before the import reads it.
(globalThis as Record<string, unknown>).__STATE__ = seeded;

const { installRenderer } = await import("./support/renderer.ts");
const r = installRenderer();
const { agent, group, ws } = await import("./support/fixtures.ts");
const m = await import("../src/cockpit/merged.ts");
const { laneOf } = await import("../src/cockpit/model.ts");

const closes = () => r.calls.filter((c) => c.method === "workspace.close").map((c) => c.params.workspace_id);
const saves = () =>
  r.opened.map((u) =>
    decodeURIComponent(u)
      .match(/key=([^&]+)&value=(\d+)/)
      ?.slice(1)
      .join("="),
  );

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

  it("dims a merged card, but not while lit or while it still wants Jon", () => {
    assert.equal(m.cardOpacity(ws("done"), false), m.MERGED_OPACITY);
    assert.equal(m.cardOpacity(ws("done"), true), 1, "a selected or dragged card reads at full strength");
    assert.equal(m.cardOpacity(ws("done", { unread: 2 }), false), 1);
    for (const s of ["working", "needs_input"] as const)
      assert.equal(m.cardOpacity(ws("done", { agents: [agent(s)] }), false), 1, s);
    assert.equal(m.cardOpacity(ws("done", { agents: [agent("idle")] }), false), m.MERGED_OPACITY);
    assert.equal(m.cardOpacity(ws("open"), false), 1);
    assert.equal(m.cardOpacity(undefined, false), 1);
  });

  it("offers the buttons on a merged card only, never on an anchor or a pinned one", () => {
    assert.equal(m.offersMergedActions(ws("done")), true);
    assert.equal(m.offersMergedActions(ws("open")), false);
    assert.equal(m.offersMergedActions(ws("anchor")), false, "closing it would take the lane's anchor");
    assert.equal(m.offersMergedActions(ws("done", { pinned: true })), false, "cmux will not close a pinned one");
    assert.equal(m.offersMergedActions(undefined), false);
  });

  it("offers Close only while no agent there is working or asking", () => {
    assert.equal(m.offersClose(ws("busy", { agents: [agent("idle")] })), true);
    for (const s of ["working", "needs_input"] as const)
      assert.equal(m.offersClose(ws("busy", { agents: [agent(s)] })), false, s);
    m.closeMerged(ws("busy", { agents: [agent("working")] }));
    assert.deepEqual(closes(), [], "a live agent is never closed");
  });

  it("holds a Keep saved before the last reload, for that PR only", () => {
    assert.equal(m.offersMergedActions(ws("saved")), false);
    assert.equal(m.cardOpacity(ws("saved"), false), m.MERGED_OPACITY, "kept cards stay dimmed");
    assert.equal(m.offersMergedActions(ws("moved")), true, "a later PR in that workspace offers them again");
  });

  it("Keep hides the buttons at once and saves the PR's number, once", () => {
    m.keepMerged(ws("kept"));
    assert.equal(m.offersMergedActions(ws("kept")), false);
    assert.deepEqual(saves(), ["mergeKept.kept=1"]);
    for (const w of [ws("kept"), ws("open"), undefined]) m.keepMerged(w);
    assert.equal(r.opened.length, 1, "nothing else writes");
  });

  it("Close closes a merged card's workspace, and nothing else", () => {
    m.closeMerged(ws("closes"));
    assert.deepEqual(closes(), ["closes"]);
    for (const w of [ws("open"), ws("saved"), ws("anchor"), undefined]) m.closeMerged(w);
    assert.deepEqual(closes(), ["closes"], "only a card that offers the button closes");
  });

  it("offers Park until the card is in Parked, and Park files it there", () => {
    assert.equal(m.offersPark(ws("inParked", { group: "g-parked" })), false, "already parked");
    assert.equal(m.offersPark(ws("open")), false, "an open PR is not parked for you");
    assert.equal(m.offersPark(ws("anchor")), false, "an anchor cannot leave its lane");
    const w = ws("parks");
    r.data.workspaces = [ws("anchor", { title: "Parked", group: "g-parked" }), w];
    assert.equal(m.offersPark(w), true);
    assert.deepEqual(r.calls, [], "nothing moves until Park is tapped");
    m.parkMerged(w);
    assert.deepEqual(r.calls.at(-1), {
      method: "workspace.group.add",
      params: { group_id: "g-parked", workspace_id: "parks" },
    });
    assert.equal(laneOf(w), "parked");
    assert.equal(m.offersPark(w), false, "Park goes once it has done its job");
  });

  it("names Keep in the card menu by what tapping it would do", () => {
    assert.equal(m.keepLabel(ws("done")), "Keep, hide Park and Close");
    assert.equal(m.keepLabel(ws("saved")), "Kept, Park and Close hidden");
    assert.equal(m.keepLabel(ws("done", { pinned: true })), "Keep, hide Park", "a pinned card shows Park alone");
    const parkedBusy = ws("done", { group: "g-parked", agents: [agent("working")] });
    assert.equal(m.keepLabel(parkedBusy), "Keep: for a merged PR's buttons", "no button shows, so none to hide");
    for (const w of [ws("open"), ws("anchor"), undefined])
      assert.equal(m.keepLabel(w), "Keep: for a merged PR's buttons");
  });

  it("Keep hides Park on a pinned card too", () => {
    m.keepMerged(ws("pinKept", { pinned: true }));
    assert.deepEqual(saves(), ["mergeKept.pinKept=1"]);
    assert.equal(m.offersPark(ws("pinKept", { pinned: true })), false);
  });

  it("offers a merged button while Park or Close shows", () => {
    assert.equal(m.offersMergedChip(ws("done")), true);
    assert.equal(m.offersMergedChip(ws("done", { pinned: true })), true, "Park alone");
    assert.equal(m.offersMergedChip(ws("done", { group: "g-parked", agents: [agent("working")] })), false);
    assert.equal(m.offersMergedChip(ws("open")), false);
  });

  it("offers Park alone on a pinned card, and none once Keep is tapped", () => {
    const pinned = ws("parks", { pinned: true });
    assert.equal(m.offersMergedActions(pinned), false);
    assert.equal(m.offersPark(pinned), true, "parking closes nothing, so a pin does not hide it");
    assert.equal(m.offersPark(ws("saved")), false, "Keep hides Park too");
    const n = r.calls.length;
    m.parkMerged(ws("saved"));
    assert.equal(r.calls.length, n, "a kept card does not park");
  });
});
