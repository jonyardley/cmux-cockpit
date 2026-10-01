// The agents panel's Made here section (#52): pages and docs agents
// published, from the saved state the published hook writes. __STATE__ is
// set before the renderer import, as in published-saved.test.ts.

import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

const entry = (id: string, workspace: string, epoch: number, kind = "page") => ({
  url: "https://claude.ai/artifact/" + id,
  title: "Title " + id,
  kind,
  workspace,
  epoch,
});

const NOW = 1_000_000;

// globalThis has no __STATE__ property in its type; the build defines it,
// and the renderer fake reads it from here, so a plain record is enough.
(globalThis as Record<string, unknown>).__STATE__ = {
  dismissed: {},
  projectOverride: {},
  projects: {},
  prs: {},
  ownPrs: {},
  subagents: {},
  published: Object.fromEntries(
    [
      entry("here-old", "sel", NOW - 500),
      entry("here-new", "sel", NOW - 100, "doc"),
      { ...entry("jp", "sel", NOW - 1000), title: " 日本語メモ " },
      entry("o1", "other", NOW - 50),
      entry("o2", "other", NOW - 60),
      entry("o3", "gone", NOW - 70),
      entry("o4", "other", NOW - 80),
      // Past the seven days: dropped even though the file still holds it.
      entry("stale", "sel", NOW - 8 * 24 * 60 * 60),
    ].map((e) => [e.url, e]),
  ),
  ui: {},
};

const { installRenderer, menuOf, modValue, nodeOf, taps } = await import("./support/renderer.ts");
const r = installRenderer();
const { agent, ws } = await import("./support/fixtures.ts");
const lists = await import("../src/agents/lists.ts");
const made = await import("../src/agents/made.ts");
const { HERE_FACE, HERE_HOVER, T } = await import("../src/agents/theme.ts");
const { madeRow } = await import("../src/agents/views/rows.ts");

const ids = () => made.madeHere().map((e) => e.url.replace("https://claude.ai/artifact/", ""));

beforeEach(() => {
  r.data.epoch = NOW;
  r.calls.length = 0;
  r.opened.length = 0;
  r.data.workspaces = [
    ws("sel", { selected: true, directory: "/Users/jon/dev/app-one" }),
    ws("other", { directory: "/Users/jon/dev/app-two" }),
  ];
});

// Opens a card for the body only, folding it again even when an assertion
// fails, so the open state never leaks into later tests.
function whileOpen(k: "prs" | "made", body: () => void): void {
  lists.toggleExpanded(k);
  try {
    body();
  } finally {
    lists.toggleExpanded(k);
  }
}

describe("madeHere", () => {
  it("puts the selected workspace's own first, newest first, then the latest three from others", () => {
    assert.deepEqual(ids(), ["here-new", "here-old", "jp", "o1", "o2", "o3"]);
  });

  it("marks no row last while a +N more line follows, so the final row keeps its rule", () => {
    // Seven fresh entries, six shown: o4 is the one left out.
    assert.deepEqual(
      made.madeHere().map((e) => e.last),
      [false, false, false, false, false, false],
    );
  });

  it("marks only the final row last when nothing is left out", () => {
    r.data.workspaces = [ws("other", { directory: "/Users/jon/dev/app-two" }), ws("sel", { selected: true })];
    r.data.epoch = NOW - 65 + 7 * 24 * 60 * 60;
    // Only o1 (NOW - 50) and o2 (NOW - 60) are still inside the seven days.
    assert.deepEqual(ids(), ["o1", "o2"]);
    assert.deepEqual(
      made.madeHere().map((e) => e.last),
      [false, true],
    );
    assert.equal(made.madeFoot(), "");
  });

  it("counts every fresh entry before the caps, and how many the caps leave out", () => {
    assert.equal(made.madeCount(), 7);
    assert.equal(made.madeFoot(), "+1 more");
  });

  it("shows every fresh entry once the card is open, and folds back to the caps (#109)", () => {
    assert.equal(made.madeFoot(), "+1 more");
    whileOpen("made", () => {
      assert.deepEqual(ids(), ["here-new", "here-old", "jp", "o1", "o2", "o3", "o4"]);
      assert.equal(made.madeFoot(), "Show less");
      assert.ok(made.madeHere().every((e) => !e.last));
    });
    assert.equal(made.madeHere().length, 6);
    assert.equal(made.madeFoot(), "+1 more");
  });

  it("opening one card leaves the other folded", () => {
    whileOpen("prs", () => {
      assert.equal(lists.isExpanded("made"), false);
      assert.equal(made.madeFoot(), "+1 more");
    });
  });

  it("shows another workspace's card folded, and the first still open on return", () => {
    whileOpen("made", () => {
      r.data.workspaces = [ws("sel"), ws("other", { selected: true })];
      assert.equal(lists.isExpanded("made"), false);
      r.data.workspaces = [ws("sel", { selected: true }), ws("other")];
      assert.equal(lists.isExpanded("made"), true);
    });
  });

  it("counts nothing before the clock's first tick", () => {
    r.data.epoch = 0;
    assert.equal(made.madeCount(), 0);
    assert.equal(made.madeFoot(), "");
  });

  it("keys each row by its link, so a row keeps its one kind", () => {
    assert.equal(made.madeHere()[0]?.key, "m:https://claude.ai/artifact/here-new");
  });

  it("takes each row's project from the workspace it was made in, none once that workspace has gone", () => {
    const byId = new Map(made.madeHere().map((e) => [e.title, e.project.name]));
    assert.equal(byId.get("Title here-new"), "App One");
    assert.equal(byId.get("Title o1"), "App Two");
    assert.equal(byId.get("Title o3"), "");
  });

  it("lists everything as from elsewhere when no workspace is selected", () => {
    r.data.workspaces = [ws("other", { directory: "/Users/jon/dev/app-two" })];
    assert.deepEqual(ids(), ["o1", "o2", "o3"]);
    assert.ok(made.madeHere().every((e) => !e.here));
  });

  it("keeps a title with no Latin letters, trimmed", () => {
    assert.ok(made.madeHere().some((e) => e.title === "日本語メモ"));
  });

  it("lists nothing before the clock's first tick, when every entry would read as fresh", () => {
    r.data.epoch = 0;
    assert.deepEqual(made.madeHere(), []);
  });

  it("drops an entry once it passes seven days on the clock", () => {
    r.data.epoch = NOW - 500 + 7 * 24 * 60 * 60 + 1;
    assert.ok(!ids().includes("here-old"));
    assert.ok(ids().includes("here-new"));
  });
});

describe("Made here row helpers", () => {
  it("sets other workspaces' titles a step back", () => {
    const rows = made.madeHere();
    const here = rows.find((e) => e.here);
    const other = rows.find((e) => !e.here);
    assert.ok(here && other);
    assert.equal(made.madeTitleColor(here), T.text);
    assert.equal(made.madeTitleColor(other), T.secondary);
  });

  // Issue #183: this chat's rows are shaded, as its PR row is.
  it("shades this chat's rows, a step darker under the pointer, and no other", () => {
    const rows = made.madeHere();
    const row = (here: boolean) => {
      const e = rows.find((x) => x.here === here);
      assert.ok(e);
      // The tappable row, under the right-click menu's wrapper.
      const root = nodeOf(madeRow(() => e));
      return root ? taps(root)[0] : undefined;
    };
    assert.equal(modValue(row(true), "background"), HERE_FACE);
    assert.equal(modValue(row(true), "hoverBackground"), HERE_HOVER);
    assert.equal(modValue(row(false), "background"), "clear");
    assert.equal(modValue(row(false), "hoverBackground"), T.hover);
  });

  it("ages each row from when it was last published", () => {
    const [first] = made.madeHere();
    assert.ok(first);
    assert.equal(made.madeAge(first), "1m");
  });
});

describe("a right-click on a Made here row", () => {
  const row = (title: string) => {
    const e = made.madeHere().find((x) => x.title === title);
    assert.ok(e, title);
    return e;
  };
  // The row itself is the one tap target, and carries the menu.
  const rowNode = (title: string) => {
    const root = nodeOf(madeRow(() => row(title)));
    return root && taps(root)[0];
  };
  const menu = (title: string) => menuOf(rowNode(title));

  it("offers Open chat, which goes to the workspace that made it and focuses its lead agent", () => {
    r.data.workspaces = [
      ws("sel", { selected: true }),
      ws("other", { agents: [agent("idle", { surfaceId: "s-other" })] }),
    ];
    const items = menu("Title o1");
    assert.deepEqual(
      items.map((i) => i.label),
      ["Open chat"],
    );
    items[0]?.action();
    assert.deepEqual(r.calls, [
      { method: "workspace.select", params: { workspace_id: "other" } },
      { method: "surface.focus", params: { surface_id: "s-other", workspace_id: "other" } },
    ]);
    assert.deepEqual(r.opened, []);
  });

  it("offers it on the selected workspace's own rows only with a terminal to focus", () => {
    assert.deepEqual(menu("Title here-new"), []);
    r.data.workspaces = [ws("sel", { selected: true, agents: [agent("idle", { surfaceId: "s-sel" })] })];
    menu("Title here-new")[0]?.action();
    assert.deepEqual(r.calls, [
      { method: "workspace.select", params: { workspace_id: "sel" } },
      { method: "surface.focus", params: { surface_id: "s-sel", workspace_id: "sel" } },
    ]);
  });

  it("has no menu once the workspace that made it has gone", () => {
    assert.equal(row("Title o3").chat, undefined);
    assert.deepEqual(menu("Title o3"), []);
  });

  it("still opens the page on a tap", () => {
    const tap = rowNode("Title o1")?.handlers.onTap;
    assert.equal(typeof tap, "function");
    if (typeof tap === "function") tap();
    assert.deepEqual(r.opened, ["https://claude.ai/artifact/o1"]);
    assert.deepEqual(r.calls, []);
  });
});
