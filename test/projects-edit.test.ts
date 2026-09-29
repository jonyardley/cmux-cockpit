// Editing a project from its header (issue #9): any project, whether from
// projects.json (seeded, as the build marks it) or made in the sidebar,
// opens in the editor under its header and saves once on Done. Seeded
// before the renderer is imported; see test/support/renderer.ts.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { beforeEach, describe, it } from "node:test";
import type { ViewNode } from "./support/renderer.ts";

const spec = { name: "Scratch", color: "#6A9BCC", icon: "folder.fill", root: "/Users/jon/dev/scratch" };
const key = "/users/jon/dev/scratch/";
const file = JSON.parse(readFileSync("config/projects.example.json", "utf8")).map((p: object) => ({
  ...p,
  seeded: true,
}));
const g = globalThis as Record<string, unknown>;
g.__PROJECTS__ = [...file, { match: key, ...spec }];
g.__STATE__ = {
  dismissed: {},
  projectOverride: { w2: key, w3: "/dev/app-one" },
  projects: { [key]: spec },
  prs: {},
  subagents: {},
  ui: {},
};

const { installRenderer, nodeOf } = await import("./support/renderer.ts");
const r = installRenderer();
const { ws } = await import("./support/fixtures.ts");
const model = await import("../src/cockpit/model.ts");
const edit = await import("../src/cockpit/edit.ts");
const state = await import("../src/cockpit/state.ts");
const { cardMenu } = await import("../src/cockpit/views/parts.ts");
const { projectHeader, quietRow } = await import("../src/cockpit/views/headers.ts");
const { projectEditor } = await import("../src/cockpit/views/editor.ts");
const { PROJECT_COLORS, PROJECT_ICONS } = await import("../src/shared/projects.ts");

const APP_ONE = "/dev/app-one";
const APP_TWO = "/dev/app-two";
const APP_THREE = "/dev/app-three";
const sets = () =>
  r.opened.map((u) => {
    const q = new URL(u).searchParams;
    const v = q.get("value");
    return [q.get("key"), v ? JSON.parse(v) : null];
  });
const menuOf = (build: () => void): string[] => {
  r.menu.length = 0;
  build();
  return [...r.menu];
};
const fields = (n: ViewNode): ViewNode[] => (n.kind === "TextField" ? [n] : n.children.flatMap((c) => fields(c)));

describe("the card menu", () => {
  it("keeps only making a project; editing moved to the header", () => {
    const items = menuOf(() => cardMenu(() => ws("w1", { directory: "/Users/jon/dev/scratch/src" })));
    assert.ok(items.includes("button:New project (folder has one, or none)"));
    assert.ok(!items.some((i) => /Next colour|Next icon|Remove project/.test(i)), items.join());
  });
});

describe("the project menu", () => {
  it("offers Edit on a file project and a sidebar-made one, not on Other", () => {
    assert.ok(menuOf(() => projectHeader(APP_ONE)).includes("button:Edit project"));
    assert.ok(menuOf(() => projectHeader(key)).includes("button:Edit project"));
    assert.ok(menuOf(() => quietRow(APP_THREE)).includes("button:Edit project"));
    assert.ok(!menuOf(() => projectHeader("other")).includes("button:Edit project"));
  });

  it("says why a project with no folder opens no session", () => {
    assert.ok(menuOf(() => projectHeader(APP_THREE)).includes("button:New session (project has no folder)"));
  });
});

describe("the editor", () => {
  beforeEach(() => {
    r.opened.length = 0;
    edit.closeEditor();
  });

  it("opens on a file project as it stands, and sits under its header", () => {
    r.data.workspaces = [ws("a", { directory: "/Users/jon/dev/app-one" })];
    edit.openEditor(APP_ONE);
    assert.equal(state.editingProject(), APP_ONE);
    assert.deepEqual(edit.draftSpec(), { name: "App One", color: "#D97757", icon: "star.fill", root: "~/dev/app-one" });
    const ids = model.projectEntries().map((e) => e.id);
    assert.equal(ids[ids.indexOf("p:" + APP_ONE) + 1], "e:" + APP_ONE);
  });

  it("sits under a quiet project's row too", () => {
    r.data.workspaces = [];
    edit.openEditor(APP_THREE);
    const ids = model.projectEntries().map((e) => e.id);
    assert.equal(ids[ids.indexOf("q:" + APP_THREE) + 1], "e:" + APP_THREE);
  });

  it("does not open for Other", () => {
    edit.openEditor("other");
    assert.equal(state.editingProject(), null);
  });

  it("saves a renamed, restyled file project once, on Done, under its first match", () => {
    edit.openEditor(APP_ONE);
    edit.setDraftName("  Alpha ");
    edit.setDraftColor(PROJECT_COLORS[3]);
    edit.setDraftIcon(PROJECT_ICONS[4]);
    assert.deepEqual(r.opened, []);
    edit.saveDraft();
    const saved = { name: "Alpha", color: PROJECT_COLORS[3], icon: PROJECT_ICONS[4], root: "~/dev/app-one" };
    assert.deepEqual(sets(), [["projects." + APP_ONE, saved]]);
    assert.equal(state.editingProject(), null);
    // Before the rebuild lands, it reopens on what was sent.
    edit.openEditor(APP_ONE);
    assert.deepEqual(edit.draftSpec(), saved);
  });

  it("only closes when nothing changed", () => {
    edit.openEditor(APP_TWO);
    edit.saveDraft();
    assert.deepEqual(r.opened, []);
    assert.equal(state.editingProject(), null);
  });

  it("says why Done will not save, and stays open", () => {
    edit.openEditor(APP_TWO);
    const problem = (name: string) => {
      edit.setDraftName(name);
      return edit.draftProblem();
    };
    assert.equal(problem("  "), "Give the project a name.");
    assert.equal(problem("x".repeat(65)), "Keep the name to 64 characters.");
    assert.equal(problem("a\tb"), "The name cannot hold tabs or line breaks.");
    assert.equal(problem("Scratch"), "Another project is called Scratch.");
    assert.equal(problem("App Two"), null);
    edit.setDraftFolder("dev/two");
    assert.equal(edit.draftProblem(), "The folder needs a full path, starting with / or ~/.");
    edit.saveDraft();
    assert.deepEqual(r.opened, []);
    assert.equal(state.editingProject(), APP_TWO);
  });

  it("drops the folder when the field is emptied", () => {
    edit.openEditor(key);
    edit.setDraftFolder("   ");
    assert.equal(edit.draftSpec().root, undefined);
    edit.setDraftFolder(" ~/dev/scratch ");
    assert.equal(edit.draftSpec().root, "~/dev/scratch");
  });

  it("types into the fields and saves on Return, as the renderer would", () => {
    edit.openEditor(key);
    const node = nodeOf(projectEditor(key));
    assert.ok(node);
    const [name, folder] = fields(node);
    assert.deepEqual(name?.args, [spec.name, { placeholder: "Project name", autofocus: true }]);
    assert.equal(folder?.args[0], spec.root);
    const onEdit = name?.handlers.onEdit;
    const onSubmit = folder?.handlers.onSubmit;
    assert.ok(typeof onEdit === "function" && typeof onSubmit === "function");
    onEdit("Scratchpad");
    onSubmit("");
    assert.deepEqual(sets(), [["projects." + key, { ...spec, name: "Scratchpad" }]]);
  });

  it("closes on Escape without saving", () => {
    edit.openEditor(APP_TWO);
    const node = nodeOf(projectEditor(APP_TWO));
    const onCancel = node && fields(node)[0]?.handlers.onCancel;
    assert.ok(typeof onCancel === "function");
    edit.setDraftName("Never saved");
    onCancel();
    assert.equal(state.editingProject(), null);
    assert.deepEqual(r.opened, []);
  });

  it("lists the folders that put a session in the project", () => {
    assert.equal(edit.matchesLine(APP_TWO), "Sessions in /dev/app-two, /.config/app-two");
  });
});

describe("removing a project", () => {
  beforeEach(() => {
    r.opened.length = 0;
    edit.closeEditor();
  });

  it("asks once, then saves a file project as removed and clears overrides to it", () => {
    edit.openEditor(APP_ONE);
    assert.equal(edit.removeLabel(), "Remove project");
    edit.removeTapped();
    assert.equal(edit.removeLabel(), "Tap again to remove");
    assert.deepEqual(r.opened, []);
    edit.removeTapped();
    assert.deepEqual(sets(), [
      ["projectOverride.w3", null],
      ["projects." + APP_ONE, { removed: true }],
    ]);
    assert.equal(state.editingProject(), null);
    assert.equal(model.hasProjectOverride(ws("w3")), false);
    // Gone until the rebuild, so it does not reopen.
    edit.openEditor(APP_ONE);
    assert.equal(state.editingProject(), null);
  });

  it("deletes a sidebar-made project's entry outright, once", () => {
    edit.openEditor(key);
    edit.removeTapped();
    edit.removeTapped();
    assert.deepEqual(sets(), [
      ["projectOverride.w2", null],
      ["projects." + key, null],
    ]);
    model.removeProject(key);
    assert.equal(r.opened.length, 2);
  });

  it("forgets a first tap when the editor closes", () => {
    edit.openEditor(APP_TWO);
    edit.removeTapped();
    edit.closeEditor();
    edit.openEditor(APP_TWO);
    assert.equal(edit.removeLabel(), "Remove project");
  });
});
