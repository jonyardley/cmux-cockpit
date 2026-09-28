// The Pull requests rows' "from" line and peek card: which chat opened each
// PR and what it first said, from the saved prOrigins map. __STATE__ is set
// before the renderer import, as in made-here.test.ts.

import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

const NOW = 1_000_000;
const pr = (n: number) => "https://github.com/o/r/pull/" + n;
const checks = [
  { name: "lint", state: "fail" },
  { name: "test", state: "pending" },
  { name: "build", state: "pass" },
  { name: "types", state: "pass" },
];

(globalThis as Record<string, unknown>).__STATE__ = {
  dismissed: {},
  projectOverride: {},
  projects: {},
  prs: {
    here: { number: 1, url: pr(1), status: "open", branch: "a", title: "Here's PR", checks },
    other: { number: 2, url: pr(2), status: "open", branch: "b", title: "Other's PR" },
  },
  ownPrs: {
    [pr(3)]: { number: 3, url: pr(3), status: "open", branch: "c", title: "Gone chat's PR", repo: "/r" },
    [pr(4)]: { number: 4, url: pr(4), status: "open", branch: "d", title: "Opened by hand", repo: "/r" },
  },
  subagents: {},
  published: {},
  prOrigins: {
    [pr(1)]: {
      url: pr(1),
      number: 1,
      workspace: "here",
      surface: "s-here",
      session: "sess1",
      epoch: NOW - 180,
      mention: { text: "Opened #1: the flaky test.", message: "m1", epoch: NOW - 170 },
    },
    [pr(2)]: { url: pr(2), number: 2, workspace: "other", session: "sess2", epoch: NOW - 60 },
    [pr(3)]: { url: pr(3), number: 3, workspace: "gone", session: "sess3", epoch: NOW - 60 },
  },
  asking: {},
  ui: {},
};

const { installRenderer } = await import("./support/renderer.ts");
const r = installRenderer();
const { ws } = await import("./support/fixtures.ts");
const m = await import("../src/agents/model.ts");
const { prRow } = await import("../src/agents/views/rows.ts");

const entry = (n: number) => {
  const e = m.prs().find((x) => x.pr.number === n);
  assert.ok(e, "row #" + n);
  return e;
};

beforeEach(() => {
  r.data.epoch = NOW;
  r.calls.length = 0;
  r.data.workspaces = [
    ws("here", { selected: true, title: "This one" }),
    ws("other", { title: "Socket contract" }),
    ws("untitled", { title: "" }),
  ];
});

describe("the row's from line", () => {
  it("says this chat, with its age, for the selected workspace", () => {
    assert.equal(m.prFromText(entry(1)), "from this chat · 3m ago");
  });

  it("names another workspace, says a closed one has gone, and is empty with no origin", () => {
    assert.equal(m.prFromText(entry(2)), "from Socket contract");
    assert.equal(m.prFromText(entry(3)), "from a closed chat");
    assert.equal(m.prFromText(entry(4)), "");
  });

  it("falls back when the workspace has no name", () => {
    const origin = { url: pr(9), number: 9, workspace: "untitled", session: "s", epoch: NOW };
    assert.equal(m.prSource({ origin }), "another chat");
  });

  it("drops the age while there is no clock", () => {
    r.data.epoch = 0;
    assert.equal(m.prSource(entry(1)), "this chat");
  });
});

describe("the peek card", () => {
  it("opens under one row at a time, and closes on a second tap", () => {
    m.togglePeek(entry(1));
    assert.ok(m.isPeeking(entry(1)));
    m.togglePeek(entry(2));
    assert.ok(!m.isPeeking(entry(1)));
    assert.ok(m.isPeeking(entry(2)));
    m.togglePeek(entry(2));
    assert.ok(!m.isPeeking(entry(2)));
  });

  it("titles itself with the number and title", () => {
    assert.equal(m.peekTitle(entry(1)), "#1 · Here's PR");
    assert.equal(m.peekTitle({ pr: {}, title: "No number" }), "No number");
  });

  it("quotes the first mention, or says the chat has not named it yet", () => {
    assert.equal(m.peekQuote(entry(1)), "Opened #1: the flaky test.");
    assert.equal(m.peekWaiting(entry(1)), "");
    assert.equal(m.peekQuote(entry(2)), "");
    assert.match(m.peekWaiting(entry(2)), /not named it/);
    assert.equal(m.peekWaiting(entry(4)), "");
  });

  it("counts the checks, worst first, and says nothing with none saved", () => {
    assert.equal(m.peekChecks(entry(1)), "1 failing · 1 running · 2 passed");
    assert.equal(m.peekChecks(entry(4)), "");
  });

  it("offers Show in chat only while the chat's workspace is open", () => {
    assert.ok(m.canShowInChat(entry(1)));
    assert.ok(m.canShowInChat(entry(2)));
    assert.ok(!m.canShowInChat(entry(3)));
    assert.ok(!m.canShowInChat(entry(4)));
  });

  it("Show in chat selects the workspace, then focuses and flashes its terminal", () => {
    m.showInChat(entry(1));
    assert.deepEqual(
      r.calls.map((c) => [c.method, c.params]),
      [
        ["workspace.select", { workspace_id: "here" }],
        ["surface.focus", { surface_id: "s-here", workspace_id: "here" }],
        ["surface.trigger_flash", { surface_id: "s-here", workspace_id: "here" }],
      ],
    );
  });

  it("Show in chat only selects when no terminal was saved, and does nothing once the chat has gone", () => {
    m.showInChat(entry(2));
    m.showInChat(entry(3));
    assert.deepEqual(
      r.calls.map((c) => c.method),
      ["workspace.select"],
    );
  });

  it("renders a row with its card open", () => {
    const e = { ...entry(1), last: true };
    m.togglePeek(e);
    try {
      assert.doesNotThrow(() => prRow(() => e));
    } finally {
      m.togglePeek(e);
    }
  });
});
