// The Pull requests rows' "from" line and tap: which chat opened each PR,
// from the saved prOrigins map, and going back to it. __STATE__ is set
// before the renderer import, as in made-here.test.ts.

import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import type { ViewNode } from "./support/renderer.ts";

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
    },
    [pr(2)]: { url: pr(2), number: 2, workspace: "other", session: "sess2", epoch: NOW - 60 },
    [pr(3)]: { url: pr(3), number: 3, workspace: "gone", session: "sess3", epoch: NOW - 60 },
  },
  asking: {},
  ui: {},
};

const { installRenderer, nodeOf } = await import("./support/renderer.ts");
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
  r.opened.length = 0;
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

describe("a tap on the row", () => {
  it("has a chat to go to only while the chat's workspace is open", () => {
    assert.ok(m.canShowInChat(entry(1)));
    assert.ok(m.canShowInChat(entry(2)));
    assert.ok(!m.canShowInChat(entry(3)));
    assert.ok(!m.canShowInChat(entry(4)));
  });

  it("opens GitHub for this chat's PR when there is no terminal to flash", () => {
    const origin = { url: pr(5), number: 5, workspace: "here", session: "s", epoch: NOW };
    assert.ok(!m.canShowInChat({ origin }));
    m.goToPr({ origin, pr: { url: pr(5) } });
    assert.deepEqual(r.calls, []);
    assert.deepEqual(r.opened, [pr(5)]);
  });

  it("selects the chat's workspace, then focuses and flashes its terminal", () => {
    m.goToPr(entry(1));
    assert.deepEqual(
      r.calls.map((c) => [c.method, c.params]),
      [
        ["workspace.select", { workspace_id: "here" }],
        ["surface.focus", { surface_id: "s-here", workspace_id: "here" }],
        ["surface.trigger_flash", { surface_id: "s-here", workspace_id: "here" }],
      ],
    );
    assert.deepEqual(r.opened, []);
  });

  it("only selects when no terminal was saved", () => {
    m.goToPr(entry(2));
    assert.deepEqual(
      r.calls.map((c) => c.method),
      ["workspace.select"],
    );
  });

  it("opens GitHub once the chat has gone, or with no origin", () => {
    m.goToPr(entry(3));
    m.goToPr(entry(4));
    assert.deepEqual(r.calls, []);
    assert.deepEqual(r.opened, [pr(3), pr(4)]);
  });

  it("keeps the pill's tap apart from the row's, so a pill tap never also jumps", () => {
    const root = nodeOf(prRow(() => ({ ...entry(1), last: true })));
    assert.ok(root);
    const taps = (n: ViewNode): ViewNode[] => [
      ...(n.mods.some((x) => x.name === "onTap") ? [n] : []),
      ...n.children.flatMap(taps),
    ];
    const tappable = taps(root);
    assert.equal(tappable.length, 2);
    for (const n of tappable) assert.deepEqual(taps(n), [n]);
  });
});
