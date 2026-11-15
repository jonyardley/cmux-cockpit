import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { installRenderer } from "./support/renderer.ts";

const r = installRenderer();
const { displayTitle, displayTitles } = await import("../src/shared/titles.ts");
const { ws } = await import("./support/fixtures.ts");

const HOME = "/Users/jon";

// Titles in list order, for compact assertions.
function titles(list: Workspace[]): string[] {
  const out = displayTitles(list);
  return list.map((w) => out.get(w.id) ?? "?");
}

describe("displayTitles", () => {
  it("leaves titles that do not collide alone", () => {
    const list = [
      ws("a", { title: "✳ Fix the bridge", directory: HOME + "/Dev/app-one" }),
      ws("b", { title: "~/Dev", directory: HOME + "/Dev/cmux-cockpit" }),
    ];
    assert.deepEqual(titles(list), ["Fix the bridge", "~/Dev"]);
  });

  it("adds the next path segment when path titles collide", () => {
    const list = [
      ws("a", { title: "~/Dev", directory: HOME + "/Dev/cmux-cockpit" }),
      ws("b", { title: "~/Dev", directory: HOME + "/Dev/app-one" }),
      ws("c", { title: "~/Dev", directory: HOME + "/Dev/app-two" }),
    ];
    assert.deepEqual(titles(list), ["~/Dev/cmux-cockpit", "~/Dev/app-one", "~/Dev/app-two"]);
  });

  it("reads /home/<user> as ~ too", () => {
    const list = [
      ws("a", { title: "~/Dev", directory: "/home/jon/Dev/one" }),
      ws("b", { title: "~/Dev", directory: "/home/jon/Dev/two/" }),
    ];
    assert.deepEqual(titles(list), ["~/Dev/one", "~/Dev/two"]);
  });

  it("goes deeper only where one segment is not enough", () => {
    const list = [
      ws("a", { title: "~/Dev", directory: HOME + "/Dev/app-one" }),
      ws("b", { title: "~/Dev", directory: HOME + "/Dev/app-one/.claude/worktrees/x" }),
      ws("c", { title: "~/Dev", directory: HOME + "/Dev/cmux-cockpit" }),
    ];
    assert.deepEqual(titles(list), ["~/Dev/app-one", "~/Dev/app-one/.claude", "~/Dev/cmux-cockpit"]);
  });

  it("numbers workspaces whose directories also match", () => {
    const list = [
      ws("a", { title: "~/Dev", directory: HOME + "/Dev" }),
      ws("b", { title: "~/Dev", directory: HOME + "/Dev" }),
      ws("c", { title: "~/Dev", directory: HOME + "/Dev" }),
    ];
    assert.deepEqual(titles(list), ["~/Dev", "~/Dev 2", "~/Dev 3"]);
  });

  it("numbers only the ones that still match after the path is added", () => {
    const list = [
      ws("a", { title: "~/Dev", directory: HOME + "/Dev/app-one" }),
      ws("b", { title: "~/Dev", directory: HOME + "/Dev/cmux-cockpit" }),
      ws("c", { title: "~/Dev", directory: HOME + "/Dev/app-one" }),
    ];
    assert.deepEqual(titles(list), ["~/Dev/app-one", "~/Dev/cmux-cockpit", "~/Dev/app-one 2"]);
  });

  it("numbers when there is no directory to go on", () => {
    const list = [ws("a", { title: "Claude Code" }), ws("b", { title: "Claude Code" })];
    assert.deepEqual(titles(list), ["Claude Code", "Claude Code 2"]);
  });

  it("suffixes a non-path title with the directory's last segment", () => {
    const list = [
      ws("a", { title: "Claude Code", directory: HOME + "/Dev/app-one" }),
      ws("b", { title: "Claude Code", directory: HOME + "/Dev/cmux-cockpit" }),
    ];
    assert.deepEqual(titles(list), ["Claude Code · app-one", "Claude Code · cmux-cockpit"]);
  });

  it("takes more trailing segments when the last ones match", () => {
    const list = [
      ws("a", { title: "Claude Code", directory: HOME + "/Dev/app-one/app" }),
      ws("b", { title: "Claude Code", directory: HOME + "/Work/client/app" }),
    ];
    assert.deepEqual(titles(list), ["Claude Code · app-one/app", "Claude Code · client/app"]);
  });

  it("suffixes a path title whose directory is elsewhere", () => {
    const list = [
      ws("a", { title: "~/Dev", directory: HOME + "/Dev/one" }),
      ws("b", { title: "~/Dev", directory: "/opt/two" }),
    ];
    assert.deepEqual(titles(list), ["~/Dev/one", "~/Dev · two"]);
  });

  it("compares title and directory case-insensitively but keeps the directory's case", () => {
    const list = [
      ws("a", { title: "~/dev", directory: HOME + "/Dev/One" }),
      ws("b", { title: "~/dev", directory: HOME + "/Dev/Two" }),
    ];
    assert.deepEqual(titles(list), ["~/dev/One", "~/dev/Two"]);
  });

  it("numbers a lengthened title that lands on another workspace's own title", () => {
    const list = [
      ws("a", { title: "~/Dev/cmux-cockpit", directory: HOME + "/Dev/cmux-cockpit" }),
      ws("b", { title: "~/Dev", directory: HOME + "/Dev/cmux-cockpit" }),
      ws("c", { title: "~/Dev", directory: HOME + "/Dev/app-one" }),
    ];
    assert.deepEqual(titles(list), ["~/Dev/cmux-cockpit", "~/Dev/cmux-cockpit 2", "~/Dev/app-one"]);
  });

  it("lets the workspace whose own title it is keep it, whatever the order", () => {
    const list = [
      ws("b", { title: "~/Dev", directory: HOME + "/Dev/cmux-cockpit" }),
      ws("a", { title: "~/Dev/cmux-cockpit", directory: HOME + "/Dev/cmux-cockpit" }),
      ws("c", { title: "~/Dev", directory: HOME + "/Dev/app-one" }),
    ];
    assert.deepEqual(titles(list), ["~/Dev/cmux-cockpit 2", "~/Dev/cmux-cockpit", "~/Dev/app-one"]);
  });

  it("keeps each workspace's label when the list order changes", () => {
    const list = [
      ws("w3", { title: "~/Dev", directory: HOME + "/Dev" }),
      ws("w1", { title: "~/Dev", directory: HOME + "/Dev" }),
      ws("w2", { title: "~/Dev", directory: HOME + "/Dev/app-one" }),
      ws("w5", { title: "~/Dev/app-one", directory: HOME + "/Dev/app-one" }),
      ws("w4", { title: "Claude Code" }),
      ws("w0", { title: "Claude Code" }),
    ];
    const forward = displayTitles(list);
    const reversed = displayTitles([...list].reverse());
    assert.deepEqual(new Map([...reversed].sort()), new Map([...forward].sort()));
    assert.equal(forward.get("w1"), "~/Dev");
    assert.equal(forward.get("w3"), "~/Dev 2");
    assert.equal(forward.get("w5"), "~/Dev/app-one");
    assert.equal(forward.get("w2"), "~/Dev/app-one 2");
    assert.equal(forward.get("w0"), "Claude Code");
    assert.equal(forward.get("w4"), "Claude Code 2");
  });

  it("does not read /Users/Shared as a home directory", () => {
    const list = [
      ws("a", { title: "~/Dev", directory: "/Users/Shared/Dev/one" }),
      ws("b", { title: "~/Dev", directory: HOME + "/Dev/one" }),
    ];
    // Read as home, both would be "~/Dev/one" and one would be numbered.
    assert.deepEqual(titles(list), ["~/Dev · one", "~/Dev/one"]);
  });

  it("does not number into a title another workspace already has", () => {
    const list = [
      ws("a", { title: "~/Dev 2" }),
      ws("b", { title: "~/Dev", directory: HOME + "/Dev" }),
      ws("c", { title: "~/Dev", directory: HOME + "/Dev" }),
    ];
    assert.deepEqual(titles(list), ["~/Dev 2", "~/Dev", "~/Dev 3"]);
  });

  it("strips spinner glyphs before comparing", () => {
    const list = [
      ws("a", { title: "✳ Claude Code", directory: HOME + "/Dev/one" }),
      ws("b", { title: "⠋ Claude Code", directory: HOME + "/Dev/two" }),
    ];
    assert.deepEqual(titles(list), ["Claude Code · one", "Claude Code · two"]);
  });

  it("keeps empty titles empty so views use their own fallback", () => {
    const list = [ws("a", { title: "", directory: HOME + "/Dev/one" }), { id: "b", directory: HOME + "/Dev/two" }];
    assert.deepEqual(titles(list), ["", ""]);
  });

  it("gives every workspace a distinct non-empty title", () => {
    const dirs = ["/Dev", "/Dev", "/Dev/a", "/Dev/a/b", "/Dev/a/c", "/Dev/b", "/x/a", ""];
    const list = dirs.map((d, i) =>
      d ? ws("w" + i, { title: "~/Dev", directory: HOME + d }) : ws("w" + i, { title: "~/Dev" }),
    );
    const shown = titles(list);
    assert.equal(new Set(shown).size, shown.length);
  });
});

describe("displayTitle", () => {
  it("reads the live workspace list", () => {
    r.data.workspaces = [
      ws("a", { title: "~/Dev", directory: HOME + "/Dev/one" }),
      ws("b", { title: "~/Dev", directory: HOME + "/Dev/two" }),
    ];
    assert.equal(displayTitle(r.data.workspaces[1]), "~/Dev/two");
  });

  it("follows changes to the workspace list", () => {
    r.data.workspaces = [ws("a", { title: "~/Dev", directory: HOME + "/Dev/one" })];
    assert.equal(displayTitle(r.data.workspaces[0]), "~/Dev");
    r.data.workspaces = [...r.data.workspaces, ws("b", { title: "~/Dev", directory: HOME + "/Dev/two" })];
    assert.equal(displayTitle(r.data.workspaces[0]), "~/Dev/one");
    r.data.workspaces = r.data.workspaces.slice(1);
    assert.equal(displayTitle(r.data.workspaces[0]), "~/Dev");
  });

  it("falls back to the cleaned title for a workspace not in the list", () => {
    r.data.workspaces = [];
    assert.equal(displayTitle(ws("z", { title: "✳ Loose" })), "Loose");
  });

  it("is empty for a missing workspace", () => {
    assert.equal(displayTitle(undefined), "");
  });
});
