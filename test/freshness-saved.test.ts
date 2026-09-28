// Stale PR data and an unreadable state file (#78). __STATE__ carries a poll
// error and __STATE_UNREADABLE__ is set before the renderer import, as in
// prs-saved.test.ts, so the sidebar modules read them at import time.

import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

const NOW = 1_000_000;
const HOUR = 60 * 60;

const saved = { number: 7, url: "https://github.com/o/r/pull/7", status: "open", branch: "feat" };
const globals = globalThis as Record<string, unknown>;
globals.__STATE__ = {
  dismissed: {},
  projectOverride: {},
  projects: {},
  prs: { w1: saved },
  ownPrs: {},
  subagents: {},
  published: {},
  ui: {},
  poll: { okEpoch: NOW - 2 * HOUR, error: "unavailable" },
};
globals.__STATE_UNREADABLE__ = true;

const { installRenderer } = await import("./support/renderer.ts");
const r = installRenderer();
const { ws } = await import("./support/fixtures.ts");
const { freshnessOf, prFreshness, STALE_AFTER, stateNotice, stateNoticeFor } = await import(
  "../src/shared/freshness.ts"
);
const m = await import("../src/agents/model.ts");

beforeEach(() => {
  r.data.epoch = NOW;
  r.data.workspaces = [];
});

describe("freshnessOf", () => {
  it("claims nothing with no poll saved, or before the clock ticks without an error", () => {
    assert.deepEqual(freshnessOf(undefined, NOW), { stale: false, line: "" });
    assert.deepEqual(freshnessOf({}, NOW), { stale: false, line: "" });
    assert.deepEqual(freshnessOf({ okEpoch: 1 }, 0), { stale: false, line: "" });
  });

  it("is fresh up to fifteen minutes after the last success", () => {
    assert.deepEqual(freshnessOf({ okEpoch: NOW - STALE_AFTER }, NOW), { stale: false, line: "" });
  });

  it("says how old the data is once past fifteen minutes", () => {
    assert.deepEqual(freshnessOf({ okEpoch: NOW - STALE_AFTER - 1 }, NOW), {
      stale: true,
      line: "Last checked 15m ago",
    });
    assert.deepEqual(freshnessOf({ okEpoch: NOW - 2 * HOUR }, NOW), { stale: true, line: "Last checked 2h ago" });
  });

  it("names a current error, with the last success when there was one", () => {
    assert.deepEqual(freshnessOf({ okEpoch: NOW - 2 * HOUR, error: "unavailable" }, NOW), {
      stale: true,
      line: "gh unavailable · last checked 2h ago",
    });
    assert.deepEqual(freshnessOf({ error: "signed-out" }, NOW), { stale: true, line: "gh signed out" });
    assert.deepEqual(freshnessOf({ okEpoch: NOW - 10, error: "missing" }, NOW), {
      stale: true,
      line: "gh not found · last checked just now",
    });
  });

  it("still names an error before the clock's first tick, without an age", () => {
    assert.deepEqual(freshnessOf({ okEpoch: 5, error: "unavailable" }, 0), { stale: true, line: "gh unavailable" });
  });

  it("reads a success ahead of the clock as just now, never blank", () => {
    assert.deepEqual(freshnessOf({ okEpoch: NOW + 30, error: "unavailable" }, NOW), {
      stale: true,
      line: "gh unavailable · last checked just now",
    });
  });
});

describe("the saved poll status", () => {
  it("reads the build's poll", () => {
    assert.deepEqual(prFreshness(NOW), { stale: true, line: "gh unavailable · last checked 2h ago" });
  });

  it("puts the line under the Pull requests heading", () => {
    assert.equal(m.prNote(), "gh unavailable · last checked 2h ago");
  });

  it("dims the poller's chips, and only those", () => {
    r.data.workspaces = [ws("w1", { branch: "feat" }), ws("own", { pr: { url: "u/9", number: 9, status: "open" } })];
    const dim = m.prs().map((e) => [e.pr.number, e.saved, m.prDim(e)]);
    assert.deepEqual(dim, [
      [9, false, false],
      [7, true, true],
    ]);
  });

  it("dims the This workspace chip while its PR is the poller's", () => {
    r.data.workspaces = [ws("w1", { branch: "feat", selected: true })];
    assert.equal(m.currentPrDim(), true);
    r.data.workspaces = [ws("w1", { selected: true, pr: { url: "u/9", number: 9, status: "open" } })];
    assert.equal(m.currentPrDim(), false);
    r.data.workspaces = [ws("none", { selected: true })];
    assert.equal(m.currentPrDim(), false);
  });
});

describe("stateNotice", () => {
  it("says the saved state could not be read when the build flagged it", () => {
    assert.equal(
      stateNotice(),
      "Saved state could not be read and was reset. The old file is config/state.json.unreadable.bak",
    );
  });

  it("says nothing when the state read fine", () => {
    assert.equal(stateNoticeFor(false), "");
    assert.equal(stateNoticeFor(true), stateNotice());
  });
});
