// The Context card at the foot of the agents panel: the context tail the
// status line puts on a workspace's description, how the move survives
// beside it, and the meters the panel draws from it.

import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import {
  isMoveDescription,
  moveDescription,
  moveOfDescription,
  type SavedContext,
  savedContext,
  splitContext,
  withContext,
} from "../scripts/state-config.ts";

const { installRenderer } = await import("./support/renderer.ts");
const r = installRenderer();
const { ws } = await import("./support/fixtures.ts");
const c = await import("../src/agents/context.ts");
const { METER_FILL, METER_TRACK, METER_WARN, T } = await import("../src/agents/theme.ts");

const NOW = 1_800_000_000;
const ctx = (extra: Partial<SavedContext> = {}): SavedContext => ({ epoch: NOW - 10, used: 18, ...extra });
const PLAN = { hour: 10, hourReset: NOW + 2 * 3600 + 60, week: 2, weekReset: NOW + 3 * 86400 + 60 };

describe("the context tail on a description", () => {
  it("round-trips after Jon's words, after a move, and alone", () => {
    const full = ctx({ tokens: 177_816, size: 1_000_000, ...PLAN });
    for (const body of ["Ship checklist", moveDescription({ text: "go", epoch: 1 }), ""]) {
      assert.deepEqual(splitContext(withContext(body, full)), { body, context: full });
    }
    assert.equal(withContext("words", null), "words");
    assert.deepEqual(splitContext("plain words"), { body: "plain words", context: null });
  });

  it("keeps a move readable with the tail after it", () => {
    const d = withContext(moveDescription({ text: "go", epoch: 1 }), ctx());
    assert.ok(isMoveDescription(d));
    assert.deepEqual(moveOfDescription(d), { text: "go", epoch: 1 });
    assert.equal(isMoveDescription(withContext("", ctx())), false);
    assert.equal(isMoveDescription(withContext("Ship checklist", ctx())), false);
  });

  it("strips a bad tail but carries no context from it", () => {
    assert.deepEqual(splitContext('words ⟦ctx {"used":18}⟧'), { body: "words", context: null });
    assert.deepEqual(splitContext("words ⟦ctx {not json}⟧"), { body: "words", context: null });
  });

  it("keeps only well formed fields", () => {
    assert.equal(savedContext({ epoch: 1, used: 101 }), null);
    assert.equal(savedContext({ epoch: -1, used: 5 }), null);
    assert.equal(savedContext([1]), null);
    assert.deepEqual(savedContext({ epoch: 1, used: 5, tokens: 1.5, size: 10, hour: 200, week: 3, weekReset: "x" }), {
      epoch: 1,
      used: 5,
      size: 10,
      week: 3,
    });
  });
});

describe("shortCount and resetsIn", () => {
  it("shortens token counts", () => {
    assert.equal(c.shortCount(950), "950");
    assert.equal(c.shortCount(177_816), "178k");
    assert.equal(c.shortCount(1_000_000), "1M");
    assert.equal(c.shortCount(1_500_000), "1.5M");
  });

  it("says when a limit resets, coarsely", () => {
    assert.equal(c.resetsIn(NOW + 30, NOW), "Resets in 1m");
    assert.equal(c.resetsIn(NOW + 40 * 60, NOW), "Resets in 40m");
    assert.equal(c.resetsIn(NOW + 3 * 3600 + 5, NOW), "Resets in 3h");
    assert.equal(c.resetsIn(NOW + 86400 + 5, NOW), "Resets in 1 day");
    assert.equal(c.resetsIn(NOW + 2 * 86400 + 5, NOW), "Resets in 2 days");
  });
});

describe("contextMeters", () => {
  beforeEach(() => {
    r.data.epoch = NOW;
    r.data.workspaces = [];
  });

  const shown = () => c.contextMeters().map(({ key, percent, detail, last }) => ({ key, percent, detail, last }));

  it("is empty until a status line has reported", () => {
    r.data.workspaces = [ws("sel", { selected: true })];
    assert.deepEqual(shown(), []);
  });

  it("shows this chat, then the plan's two limits", () => {
    r.data.workspaces = [
      ws("sel", { selected: true, description: withContext("", ctx({ tokens: 177_816, size: 1_000_000, ...PLAN })) }),
    ];
    assert.deepEqual(shown(), [
      { key: "chat", percent: 18, detail: "178k of 1M", last: false },
      { key: "hour", percent: 10, detail: "Resets in 2h", last: false },
      { key: "week", percent: 2, detail: "Resets in 3 days", last: true },
    ]);
  });

  it("takes the plan from the newest reading of any workspace, the chat only from the selected one", () => {
    r.data.workspaces = [
      ws("sel", {
        selected: true,
        description: withContext("Ship checklist", ctx({ used: 40, hour: 5, epoch: NOW - 900 })),
      }),
      ws("busy", { description: withContext("", ctx({ used: 90, hour: 30, epoch: NOW - 5 })) }),
      ws("noplan", { description: withContext("", ctx({ used: 50, epoch: NOW })) }),
    ];
    assert.deepEqual(shown(), [
      { key: "chat", percent: 40, detail: "", last: false },
      { key: "hour", percent: 30, detail: "", last: true },
    ]);
  });

  it("shows the plan alone when the selected chat has not reported", () => {
    r.data.workspaces = [
      ws("sel", { selected: true }),
      ws("other", { description: withContext("", ctx({ week: 7 })) }),
    ];
    assert.deepEqual(shown(), [{ key: "week", percent: 7, detail: "", last: true }]);
  });

  it("reads a limit whose reset has passed as reset", () => {
    r.data.workspaces = [
      ws("sel", { selected: true, description: withContext("", ctx({ hour: 95, hourReset: NOW - 1 })) }),
    ];
    assert.deepEqual(shown()[1], { key: "hour", percent: 0, detail: "Reset", last: true });
  });

  it("leaves reset times out before the first clock tick", () => {
    r.data.epoch = 0;
    r.data.workspaces = [ws("sel", { selected: true, description: withContext("", ctx(PLAN)) })];
    assert.deepEqual(
      shown().map((m) => m.detail),
      ["", "", ""],
    );
  });
});

describe("colours", () => {
  const meter = (percent: number) => ({ key: "chat", label: "This chat", percent, detail: "" });

  it("turns the percent and the filled steps amber from 80%", () => {
    assert.equal(c.percentColor(meter(79)), T.secondary);
    assert.equal(c.percentColor(meter(80)), T.amberText);
    assert.equal(c.stepColor(meter(79), 0), METER_FILL);
    assert.equal(c.stepColor(meter(80), 0), METER_WARN);
  });

  it("fills one step per 5%, and always the first above 0", () => {
    const filled = (p: number) =>
      Array.from({ length: c.STEPS }, (_, i) => c.stepColor(meter(p), i)).filter((x) => x !== METER_TRACK).length;
    assert.equal(filled(0), 0);
    assert.equal(filled(1), 1);
    assert.equal(filled(18), 4);
    assert.equal(filled(50), 10);
    assert.equal(filled(100), 20);
  });
});
