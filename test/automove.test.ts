// Lanes that move themselves (automove.ts): a PR turning ready files its
// workspace into For review, and a merge files it into Parked, only on the
// change itself. __STATE__ is set before the renderer import, as in
// prs-saved.test.ts, and the PRs are edited in place between steps, since
// SAVED_STATE is that same object.

import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { emptyState, type SavedPr, type State } from "../scripts/state-config.ts";

const base: SavedPr = { number: 1, url: "https://github.com/o/r/pull/1", status: "open", branch: "feat" };
const ready: SavedPr = { ...base, mergeable: true, checks: [{ name: "build", state: "pass" }] };
const running: SavedPr = { ...base, checks: [{ name: "build", state: "pending" }] };
const merged: SavedPr = { ...ready, status: "merged" };

const seeded: State = {
  ...emptyState(),
  prSeen: {
    a: "other",
    c: "ready",
    c2: "other",
    held: "other",
    proj: "other",
    same: "ready",
    dragged: "other",
    gone: "other",
    back: "ready",
    two1: "other",
    two2: "other",
    waits: "other",
  },
};
(globalThis as Record<string, unknown>).__STATE__ = seeded;

const { installRenderer } = await import("./support/renderer.ts");
const r = installRenderer();
const { group, ws } = await import("./support/fixtures.ts");
const auto = await import("../src/cockpit/automove.ts");
const state = await import("../src/cockpit/state.ts");
const { SAVED_STATE } = await import("../src/shared/persist.ts");

const prs = SAVED_STATE.prs;

function setup(): void {
  r.data.epoch += 100;
  r.data.groups = [
    group("g-main", "Main activity", { anchorId: "anchor-main" }),
    group("g-review", "For review", { anchorId: "anchor-review" }),
    group("g-parked", "Parked", { anchorId: "anchor-parked" }),
  ];
  r.data.workspaces = [
    ws("anchor-main", { title: "Main activity", group: "g-main" }),
    ws("anchor-review", { title: "For review", group: "g-review" }),
    ws("anchor-parked", { title: "Parked", group: "g-parked" }),
  ];
  r.calls.length = 0;
  r.opened.length = 0;
  state.setDrag(null);
}

const joins = () =>
  r.calls.filter((c) => c.method === "workspace.group.add").map((c) => `${c.params.workspace_id}>${c.params.group_id}`);
const saves = () =>
  r.opened.map((u) =>
    decodeURIComponent(u)
      .match(/key=([^&]+)&value="([a-z]+)"/)
      ?.slice(1)
      .join("="),
  );

describe("lanes that move themselves", () => {
  beforeEach(setup);

  it("leaves a workspace alone until the poller has seeded its state, and writes nothing", () => {
    prs.fresh = ready;
    r.data.workspaces.push(ws("fresh", { group: "g-main" }));
    assert.equal(auto.autoMoveNotice(), "");
    assert.deepEqual(joins(), []);
    assert.deepEqual(saves(), []);
  });

  it("does not re-file a ready PR whose checks rerun and pass again", () => {
    prs.back = running;
    r.data.workspaces.push(ws("back", { group: "g-main" }));
    auto.applyAutoMoves();
    prs.back = ready;
    auto.applyAutoMoves();
    assert.deepEqual(joins(), [], "Jon dragged it out of For review, so it stays out");
    assert.deepEqual(saves(), []);
  });

  it("names every card one pass moves", () => {
    prs.two1 = merged;
    prs.two2 = merged;
    r.data.workspaces.push(
      ws("two1", { title: "One", group: "g-main" }),
      ws("two2", { title: "Two", group: "g-main" }),
    );
    assert.equal(auto.autoMoveNotice(), "Moved One to Parked: PR merged · Moved Two to Parked: PR merged");
  });

  it("waits for cmux's clock and its groups before moving anything", () => {
    prs.waits = ready;
    r.data.workspaces.push(ws("waits", { group: "g-main" }));
    const groups = r.data.groups;
    r.data.groups = [];
    auto.applyAutoMoves();
    r.data.groups = groups;
    const epoch = r.data.epoch;
    r.data.epoch = 0;
    auto.applyAutoMoves();
    assert.deepEqual(joins(), []);
    assert.deepEqual(saves(), []);
    r.data.epoch = epoch;
    auto.applyAutoMoves();
    assert.deepEqual(joins(), ["waits>g-review"]);
  });

  it("files a PR that turns ready into For review, and says so", () => {
    prs.a = ready;
    r.data.workspaces.push(ws("a", { title: "Alpha", group: "g-main" }));
    assert.equal(auto.autoMoveNotice(), "Moved Alpha to For review: PR is ready");
    assert.deepEqual(joins(), ["a>g-review"]);
    assert.deepEqual(saves(), ["prSeen.a=ready"]);
  });

  it("files a merged PR into Parked, from For review", () => {
    prs.c = merged;
    r.data.workspaces.push(ws("c", { title: "Beta", group: "g-review" }));
    assert.equal(auto.autoMoveNotice(), "Moved Beta to Parked: PR merged");
    assert.deepEqual(joins(), ["c>g-parked"]);
  });

  it("leaves a workspace already in the target lane where it is", () => {
    prs.c2 = ready;
    r.data.workspaces.push(ws("c2", { group: "g-review" }));
    auto.applyAutoMoves();
    assert.deepEqual(joins(), []);
    assert.deepEqual(saves(), ["prSeen.c2=ready"], "still recorded, so a later drag holds");
  });

  it("does not move on a state it has already seen, so a drag holds", () => {
    prs.same = ready;
    r.data.workspaces.push(ws("same", { group: "g-main" }));
    auto.applyAutoMoves();
    assert.deepEqual(joins(), []);
    assert.deepEqual(saves(), [], "nothing new to save either");
  });

  it("holds a drag after its own move until the PR changes again", () => {
    prs.held = ready;
    r.data.workspaces.push(ws("held", { group: "g-main" }));
    auto.applyAutoMoves();
    assert.deepEqual(joins(), ["held>g-review"]);
    // Jon drags it back to Main activity: cmux reports it there.
    r.data.epoch += 100;
    r.calls.length = 0;
    r.data.workspaces = r.data.workspaces.map((w) => (w.id === "held" ? { ...w, group: "g-main" } : w));
    auto.applyAutoMoves();
    assert.deepEqual(joins(), []);
    // Then the PR merges: that is a change, so it moves again.
    prs.held = merged;
    auto.applyAutoMoves();
    assert.deepEqual(joins(), ["held>g-parked"]);
  });

  it("never moves a workspace that anchors a group", () => {
    prs.proj = ready;
    r.data.groups.push(group("g-proj", "Beta", { anchorId: "proj" }));
    r.data.workspaces.push(ws("proj", { group: "g-proj" }));
    auto.applyAutoMoves();
    assert.deepEqual(joins(), []);
    assert.deepEqual(saves(), ["prSeen.proj=ready"]);
  });

  it("waits out a drag, then applies the change", () => {
    prs.dragged = ready;
    r.data.workspaces.push(ws("dragged", { group: "g-main" }));
    state.setDrag({ id: "dragged", index: 0 });
    auto.applyAutoMoves();
    assert.deepEqual(joins(), []);
    assert.deepEqual(saves(), [], "not even recorded, so the change is still seen after");
    state.setDrag(null);
    auto.applyAutoMoves();
    assert.deepEqual(joins(), ["dragged>g-review"]);
  });

  it("takes the notice down after NOTICE_SECS", () => {
    prs.gone = ready;
    r.data.workspaces.push(ws("gone", { title: "Gone", group: "g-main" }));
    assert.equal(auto.autoMoveNotice(), "Moved Gone to For review: PR is ready");
    r.data.epoch += auto.NOTICE_SECS - 1;
    assert.notEqual(auto.autoMoveNotice(), "");
    r.data.epoch += 1;
    assert.equal(auto.autoMoveNotice(), "");
  });
});
