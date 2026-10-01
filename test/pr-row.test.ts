// The Pull requests rows' faint line and tap: the session each PR belongs to
// (the workspace holding it, else the chat that opened it, from the saved
// prOrigins map), its project, and a tap on the row opening it. __STATE__ is set
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
    [pr(4)]: {
      number: 4,
      url: pr(4),
      status: "open",
      branch: "d",
      title: "Opened by hand",
      repo: "/Users/j/dev/app-two/.git",
    },
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

const { installRenderer, modValue, nodeOf, taps } = await import("./support/renderer.ts");
const r = installRenderer();
const { agent, ws } = await import("./support/fixtures.ts");
const { HERE_FACE, HERE_HOVER, STATUS_DOT, T } = await import("../src/agents/theme.ts");
const { P } = await import("../src/shared/palette.ts");
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

describe("the row's session and project", () => {
  it("names the holding workspace, This chat when selected, with its lead agent's dot", () => {
    r.data.workspaces = [
      ws("here", { selected: true, title: "This one", agents: [agent("working")] }),
      ws("other", { title: "Socket contract" }),
    ];
    assert.deepEqual(entry(1).session, { name: "This chat", dot: STATUS_DOT.working, hollow: false, here: true });
    // No agent: a hollow grey ring, as elsewhere in the panel.
    assert.deepEqual(entry(2).session, { name: "Socket contract", dot: T.grey, hollow: true, here: false });
  });

  it("names the chat that opened an own PR while it is open, else none", () => {
    assert.equal(entry(3).session, undefined);
    assert.equal(entry(4).session, undefined);
    r.data.workspaces = [...(r.data.workspaces ?? []), ws("gone", { title: "Back again" })];
    assert.equal(entry(3).session?.name, "Back again");
  });

  it("writes the number, or nothing before GitHub gives one", () => {
    assert.equal(m.prNumberText(entry(1)), "#1");
    assert.equal(m.prNumberText({ pr: { url: pr(9) } }), "");
  });

  it("titles a PR with no saved title by its label or branch, since the faint line names the workspace", () => {
    r.data.workspaces = [
      ws("w", { title: "Socket contract", pr: { url: pr(7), number: 7, status: "open", branch: "sock", label: "PR" } }),
    ];
    assert.equal(entry(7).title, "sock");
    assert.equal(entry(7).session?.name, "Socket contract");
  });

  it("falls back when the workspace has no name", () => {
    r.data.workspaces = [ws("here", { title: "" }), ws("other", { title: "" })];
    assert.equal(entry(2).session?.name, "Another chat");
  });

  it("takes the project from the session's folder, else the own PR's repo, grey when neither matches", () => {
    r.data.workspaces = [
      ws("here", { selected: true, directory: "/Users/j/dev/app-one" }),
      ws("other", { directory: "/elsewhere" }),
      ws("gone", { directory: "/Users/j/dev/app-three/wt" }),
    ];
    assert.equal(entry(1).project.name, "App One");
    assert.equal(entry(2).project.name, "");
    assert.equal(entry(2).project.color, P.grey);
    // #3's opener is open again, so its folder wins over the repo.
    assert.equal(entry(3).project.name, "App Three");
    // #4 has no opener, so its repo names the project.
    assert.equal(entry(4).project.name, "App Two");
  });
});

// Issue #183: this chat's PR is the one to find, so it leads the list and
// its row is shaded, whatever its number.
describe("this chat's own PR", () => {
  const order = () => m.prs().map((e) => e.pr.number);
  const row = (n: number) => nodeOf(prRow(() => ({ ...entry(n), last: true })))?.children[0];

  it("sorts first, ahead of higher numbers and PRs no workspace holds", () => {
    assert.deepEqual(order(), [1, 2, 4, 3]);
    assert.ok(m.isHerePr(entry(1)));
    assert.ok(!m.isHerePr(entry(2)));
  });

  it("follows the selection to another workspace", () => {
    r.data.workspaces = [ws("here", { title: "This one" }), ws("other", { selected: true, title: "Socket contract" })];
    assert.deepEqual(order(), [2, 1, 4, 3]);
    assert.equal(entry(2).session?.name, "This chat");
  });

  it("leads with an own PR this chat opened", () => {
    r.data.workspaces = [ws("here", { title: "This one" }), ws("gone", { selected: true, title: "Back again" })];
    assert.equal(order()[0], 3);
    assert.equal(entry(3).session?.name, "This chat");
  });

  it("keeps the card's PR first once merged, ahead of open PRs", () => {
    r.data.workspaces = [
      ws("w", { selected: true, pr: { url: pr(8), number: 8, status: "merged", branch: "m" } }),
      ws("other", { title: "Socket contract" }),
    ];
    assert.equal(order()[0], 8);
  });

  it("leaves this chat's other merged PRs in place, so open ones stay in the folded cut", () => {
    r.data.workspaces = [
      ws("w", {
        selected: true,
        prs: [
          { url: pr(20), number: 20, status: "open", branch: "a" },
          { url: pr(21), number: 21, status: "merged", branch: "b" },
          { url: pr(22), number: 22, status: "merged", branch: "c" },
          { url: pr(23), number: 23, status: "merged", branch: "d" },
        ],
      }),
      ws("other", { title: "Socket contract" }),
    ];
    // #20 is the card's and open; the merged three sort after every open PR.
    assert.deepEqual(order(), [20, 2, 4, 3, 23]);
    assert.ok(m.isHerePr(entry(23)));
  });

  it("shades this chat's row, a step darker under the pointer, and no other", () => {
    assert.equal(modValue(row(1), "background"), HERE_FACE);
    assert.equal(modValue(row(1), "hoverBackground"), HERE_HOVER);
    assert.equal(modValue(row(2), "background"), "clear");
    assert.equal(modValue(row(2), "hoverBackground"), T.hover);
  });
});

describe("a tap on the row", () => {
  it("has one tap target, the whole row, so a tap anywhere opens the PR", () => {
    const root = nodeOf(prRow(() => ({ ...entry(1), last: true })));
    assert.ok(root);
    const tappable = taps(root);
    assert.equal(tappable.length, 1);
    // The row itself, the first child of the ruled wrapper.
    assert.equal(tappable[0], root.children[0]);
    assert.ok(tappable[0]?.mods.some((x) => x.name === "hoverBackground"));
  });

  it("opens the PR on GitHub and never switches chats", () => {
    const root = nodeOf(prRow(() => ({ ...entry(1), last: true })));
    const tap = root?.children[0]?.handlers.onTap;
    assert.equal(typeof tap, "function");
    if (typeof tap === "function") tap();
    assert.deepEqual(r.opened, [pr(1)]);
    assert.deepEqual(r.calls, []);
  });
});
