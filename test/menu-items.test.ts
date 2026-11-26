// The right-click menus' model: what remote text a menu may copy, the list's
// tidy shape, choosing an item by its label, and what the row draws with no items.

import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { seed } from "./support/snapshot.ts";

const r = seed();
const { menuOf, nodeOf, taps } = await import("./support/renderer.ts");
const { agent, ws } = await import("./support/fixtures.ts");
const { copyableBranch, copyableLink } = await import("../src/shared/copyable.ts");
const { chooseMenuItem, runMenu, tidyMenu, menuKey } = await import("../src/agents/menus.ts");
const { prMenu } = await import("../src/agents/pr-list.ts");
const { agentMenu } = await import("../src/agents/team.ts");
const { madeMenu } = await import("../src/agents/made.ts");
const { withMenu } = await import("../src/agents/views/parts.ts");

type Entry = import("../src/agents/menus.ts").MenuEntry;
const labels = (items: readonly Entry[]) => items.map((i) => (i === "divider" ? i : i.label));
const g = globalThis as Record<string, unknown>;
const takeAll = g.clipboard;

beforeEach(() => {
  r.calls.length = 0;
  r.copied.length = 0;
  r.opened.length = 0;
  g.clipboard = takeAll;
  r.data.workspaces = [ws("w", { agents: [agent("working", { surfaceId: "s-w" })] })];
});

describe("what a menu may copy", () => {
  it("keeps a plain branch name", () => {
    assert.equal(copyableBranch("feat/menus-1.2_x"), "feat/menus-1.2_x");
    assert.equal(
      copyableBranch("dependabot/npm_and_yarn/@types/node-20.11.0+x"),
      "dependabot/npm_and_yarn/@types/node-20.11.0+x",
    );
  });

  it("drops a branch with a newline, a space or $(...)", () => {
    for (const bad of ["main\nrm -rf ~", "a b", "$(id)", "", undefined, "x".repeat(256)]) {
      assert.equal(copyableBranch(bad), undefined, JSON.stringify(bad));
    }
  });

  it("keeps a plain https link", () => {
    for (const ok of ["https://github.com/o/r/pull/12", "https://h.example:8443/a?b=c#d"]) {
      assert.equal(copyableLink(ok), ok);
    }
  });

  it("drops a link with a newline, a space, $(...), a control or no https", () => {
    const bad = [
      "https://github.com/o/r\n/pull/1",
      "https://github.com/o r",
      "https://github.com/$(id)",
      "https://github.com/\u0007",
      "http://github.com/o/r/pull/1",
      "javascript:alert(1)",
      "https://",
      undefined,
    ];
    for (const b of bad) assert.equal(copyableLink(b), undefined, JSON.stringify(b));
  });

  it("leaves unsafe text out of a PR row's and an agent row's menu", () => {
    const pr = { url: "https://x/$(id)", branch: "a\nb", number: 1, status: "open" as const, title: "t" };
    assert.deepEqual(labels(prMenu({ pr, session: undefined })), ["Open pull request"]);
    assert.deepEqual(labels(agentMenu(agent("idle"), ws("w", { branch: "a b" }))), ["Go to this agent"]);
  });
});

describe("the menu's shape", () => {
  const item = (label: string): Entry => ({ label, does: { open: "https://x/" + label } });

  it("never starts or ends with a divider, nor holds two together", () => {
    assert.deepEqual(labels(tidyMenu(["divider", item("a"), "divider", "divider", item("b"), "divider"])), [
      "a",
      "divider",
      "b",
    ]);
    assert.deepEqual(tidyMenu(["divider"]), []);
  });

  it("offers a PR's chat alone, with no divider, when it has no link or branch", () => {
    const pr = { number: 1, status: "open" as const, title: "t" };
    assert.deepEqual(labels(prMenu({ pr, session: { name: "n", chat: "w", dot: "", hollow: false, here: false } })), [
      "Go to its chat",
    ]);
    assert.deepEqual(prMenu({ pr, session: undefined }), []);
  });

  it("keys a row by its labels", () => {
    assert.equal(menuKey([item("a"), "divider", item("b")]), "menu:a|-|b");
  });

  it("offers a Made here row's chat while its workspace is open", () => {
    assert.deepEqual(labels(madeMenu({ chat: "w" })), ["Go to its chat"]);
    assert.deepEqual(madeMenu({ chat: undefined }), []);
  });
});

describe("choosing an item", () => {
  it("runs the item with that label in the list as it is now", () => {
    const now: Entry[] = [{ label: "Copy branch name", does: { copy: "b" } }];
    assert.equal(chooseMenuItem(now, "Copy branch name"), true);
    assert.deepEqual(r.copied, ["b"]);
  });

  it("does nothing once the item has gone", () => {
    assert.equal(chooseMenuItem([{ label: "Copy link", does: { copy: "x" } }, "divider"], "Copy branch name"), false);
    assert.deepEqual(r.copied, []);
  });

  it("acts on the item by label when the list changed while the menu was open", () => {
    let items: Entry[] = [
      { label: "Copy link", does: { copy: "link" } },
      { label: "Copy branch name", does: { copy: "branch" } },
    ];
    const root = nodeOf(
      withMenu(
        () => Text("row").onTap(() => {}),
        () => items,
      ),
    );
    const menu = menuOf(root && taps(root)[0]);
    items = [{ label: "Copy branch name", does: { copy: "branch" } }];
    menu[0]?.action();
    assert.deepEqual(r.copied, [], "Copy link has gone, so nothing is copied");
    menu[1]?.action();
    assert.deepEqual(r.copied, ["branch"]);
  });

  it("reports a refused clipboard write", () => {
    g.clipboard = { write: () => false };
    assert.equal(runMenu({ copy: "b" }), false);
  });

  it("goes to a chat's lead agent, or reports the workspace has gone", () => {
    assert.equal(runMenu({ chat: "w" }), true);
    assert.equal(runMenu({ chat: "gone" }), false);
    assert.deepEqual(r.calls, [
      { method: "workspace.select", params: { workspace_id: "w" } },
      { method: "surface.focus", params: { surface_id: "s-w", workspace_id: "w" } },
    ]);
  });

  it("opens a link and goes to an agent", () => {
    assert.equal(runMenu({ open: "https://x/1" }), true);
    assert.equal(runMenu({ agent: { wsId: "w", surfaceId: undefined } }), true);
    assert.deepEqual(r.opened, ["https://x/1"]);
    assert.deepEqual(r.calls, [{ method: "workspace.select", params: { workspace_id: "w" } }]);
  });
});

describe("a row with no menu items", () => {
  it("draws the row with no context menu", () => {
    const root = nodeOf(
      withMenu(
        () => Text("row").onTap(() => {}),
        () => ["divider"],
      ),
    );
    const row = root && taps(root)[0];
    assert.ok(row, "the row is drawn");
    assert.equal(row.handlers.contextMenu, undefined);
    assert.ok(!row.mods.some((m) => m.name === "contextMenu"));
  });
});
