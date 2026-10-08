// Merged PRs (merged.ts): a merged card dims while nothing in it wants Jon,
// and nothing moves or closes it by itself. __STATE__ is set before the
// renderer import, as in prs-saved.test.ts, so the saved PRs are read.

import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { emptyState, type SavedPr, type State } from "../scripts/state-config.ts";

const base: SavedPr = { number: 1, url: "https://github.com/o/r/pull/1", status: "open", branch: "feat" };
const merged: SavedPr = { ...base, status: "merged" };

const seeded: State = { ...emptyState(), prs: { done: merged, open: base } };
// globalThis has no __STATE__ property in its type; the bundle's build
// defines it, so a test sets it by name before the import reads it.
(globalThis as Record<string, unknown>).__STATE__ = seeded;

const { installRenderer } = await import("./support/renderer.ts");
const r = installRenderer();
const { agent, ws } = await import("./support/fixtures.ts");
const m = await import("../src/cockpit/merged.ts");

describe("merged cards", () => {
  beforeEach(() => {
    r.data.epoch += 100;
    r.calls.length = 0;
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

  it("never moves or closes a merged card by itself", () => {
    m.cardOpacity(ws("done"), false);
    assert.deepEqual(r.calls, []);
  });
});
