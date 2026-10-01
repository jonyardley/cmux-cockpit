// Making a project from a folder, from "+ New project" under the busy
// projects or from a card's chip under Other. __HOME__ is seeded before
// the renderer is imported, as build.ts bakes it in.

import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

(globalThis as Record<string, unknown>).__HOME__ = "/Users/jon/";

const { installRenderer } = await import("./support/renderer.ts");
const r = installRenderer();
const { ws } = await import("./support/fixtures.ts");
const model = await import("../src/cockpit/by-project.ts");
const edit = await import("../src/cockpit/edit.ts");
const state = await import("../src/cockpit/state.ts");
const parts = await import("../src/cockpit/views/parts.ts");
const { expandHome, isHome, tildeHome } = await import("../src/shared/home.ts");
const { nextColor, PROJECT_COLORS } = await import("../src/shared/projects.ts");

const sets = () =>
  r.opened.map((u) => {
    const q = new URL(u).searchParams;
    const v = q.get("value");
    return [q.get("key"), v ? JSON.parse(v) : null];
  });
const creates = () => r.calls.filter((c) => c.method === "workspace.create").map((c) => c.params.cwd);

// Each test makes its own folder, since a project sent stays known for the file.
let n = 0;
const folder = () => `~/dev/fresh-${++n}`;

// A project sent from the sidebar and not yet built, as a save leaves it.
const sendProject = (name: string, root: string) => {
  const dir = expandHome(root) ?? root;
  const k = `${dir.toLowerCase()}/`;
  model.saveProject(k, { name, color: PROJECT_COLORS[0] ?? "", icon: "star.fill", root });
  r.opened.length = 0;
  return k;
};

beforeEach(() => {
  r.opened.length = 0;
  r.calls.length = 0;
  r.data.workspaces = [];
  edit.closeEditor();
  state.setMode("projects");
});

describe("the home folder", () => {
  it("expands a leading ~ and leaves other paths alone", () => {
    assert.equal(expandHome(" ~/dev/app "), "/Users/jon/dev/app");
    assert.equal(expandHome("~"), "/Users/jon");
    assert.equal(expandHome("/opt/x"), "/opt/x");
    assert.equal(expandHome("~other/x"), "~other/x");
  });

  it("has no answer for ~ when no home is known", () => {
    assert.equal(expandHome("~/dev/app", ""), null);
    assert.equal(expandHome("/dev/app", ""), "/dev/app");
  });

  it("shows a path under home with ~", () => {
    assert.equal(tildeHome("/Users/jon/dev/app"), "~/dev/app");
    assert.equal(tildeHome("/Users/jon"), "~");
    assert.equal(tildeHome("/Users/jonny/dev"), "/Users/jonny/dev");
    assert.equal(tildeHome("/Users/jon/dev", ""), "/Users/jon/dev");
  });

  it("knows the home folder in any case, with or without a trailing /", () => {
    assert.equal(isHome("/users/JON/"), true);
    assert.equal(isHome("/Users/jon"), true);
    assert.equal(isHome("/Users/jonny"), false);
    assert.equal(isHome("/Users/jon", ""), false);
  });
});

describe("the next colour", () => {
  it("is the first one no project uses, and goes round once all are taken", () => {
    const p = (color: string) => ({ match: "/a/b", name: color, color, icon: "star.fill" });
    assert.equal(nextColor([]), PROJECT_COLORS[0]);
    assert.equal(nextColor([p(PROJECT_COLORS[0] ?? "").color.toLowerCase()].map(p)), PROJECT_COLORS[1]);
    const all = PROJECT_COLORS.map(p);
    assert.equal(nextColor(all), PROJECT_COLORS[all.length % PROJECT_COLORS.length]);
  });
});

describe("+ New project", () => {
  it("sits after the busy projects and before the quiet ones, its editor under it", () => {
    r.data.workspaces = [ws("a", { directory: "/Users/jon/dev/app-one" })];
    edit.openNewProject();
    const ids = model.projectEntries().map((e) => e.id);
    assert.deepEqual(ids.slice(ids.indexOf("new"), ids.indexOf("new") + 3), ["new", "e:+new", "quiet"]);
  });

  it("opens blank in the next free colour, and a second tap closes it", () => {
    edit.openNewProject();
    assert.equal(edit.isNewDraft(), true);
    assert.equal(edit.draftSpec().name, "");
    assert.equal(edit.draftSpec().color, nextColor(model.knownProjects()));
    edit.openNewProject();
    assert.equal(state.editingProject(), null);
  });

  it("names the project after the folder as it is typed", () => {
    edit.openNewProject();
    edit.setDraftFolder("~/dev/pianola-roll");
    assert.equal(edit.draftSpec().name, "Pianola-roll");
    edit.setDraftFolder("~");
    assert.equal(edit.draftSpec().name, "");
  });

  it("says what is wrong with the folder, in words", () => {
    edit.openNewProject();
    assert.equal(edit.draftProblem(), "Type the project's folder.");
    edit.setDraftFolder("~");
    assert.equal(edit.draftProblem(), "That is your home folder: pick one inside it, such as ~/dev/app.");
    edit.setDraftFolder("/opt");
    assert.equal(edit.draftProblem(), "Pick a folder at least two levels deep, such as ~/dev/app.");
    edit.setDraftFolder("/opt/tools");
    assert.equal(edit.draftProblem(), null);
    edit.setDraftFolder("~/dev/app-one/web");
    assert.equal(edit.draftProblem(), "That folder is already in App One.");
  });

  it("wants a full path, not a relative one or another user's ~", () => {
    edit.openNewProject();
    for (const typed of ["dev/app", "~bob/app"]) {
      edit.setDraftFolder(typed);
      assert.equal(edit.draftProblem(), "Type the folder's full path, starting with / or ~/.");
    }
  });

  it("calls the home folder home in any case", () => {
    edit.openNewProject();
    edit.setDraftFolder("/USERS/jon/");
    assert.equal(edit.draftProblem(), "That is your home folder: pick one inside it, such as ~/dev/app.");
  });

  it("says when a folder is too long once its ~ is expanded", () => {
    edit.openNewProject();
    edit.setDraftFolder(`~/${"x".repeat(505)}`);
    assert.equal(edit.draftProblem(), "Keep the folder's path under 512 characters.");
    assert.equal(edit.draftSpec().name, "");
  });

  it("counts a project sent but not yet built", () => {
    sendProject("Sent Only", "/Users/jon/dev/sent-only");
    edit.openNewProject();
    edit.setDraftFolder("~/dev/sent-only/src");
    assert.equal(edit.draftProblem(), "That folder is already in Sent Only.");
  });

  it("refuses a folder that holds other projects", () => {
    edit.openNewProject();
    edit.setDraftFolder("~/dev");
    assert.equal(edit.draftProblem(), "~/dev holds other projects, such as App One: pick a folder inside it.");
  });

  it("takes a removed project's folder again", () => {
    const k = sendProject("Gone Soon", "/Users/jon/dev/gone-soon");
    model.removeProject(k);
    edit.openNewProject();
    edit.setDraftFolder("~/dev/gone-soon");
    assert.equal(edit.draftProblem(), null);
    assert.equal(edit.draftSpec().name, "Gone-soon");
  });

  it("saves under the expanded folder and opens a workspace there", () => {
    const f = folder();
    const color = nextColor(model.knownProjects());
    edit.openNewProject();
    edit.setDraftFolder(f);
    edit.setDraftIcon("music.note");
    edit.saveDraft();
    const dir = `/Users/jon${f.slice(1)}`;
    assert.deepEqual(sets(), [
      [`projects.${dir.toLowerCase()}/`, { name: `Fresh-${n}`, color, icon: "music.note", root: dir }],
    ]);
    assert.deepEqual(creates(), [dir]);
    assert.equal(state.editingProject(), null);
  });

  it("opens no second workspace in a folder that has one", () => {
    r.data.workspaces = [ws("s", { directory: "/Users/jon/dev/sketch/" })];
    edit.openNewProject();
    edit.setDraftFolder("~/dev/sketch");
    edit.saveDraft();
    assert.equal(sets().length, 1);
    assert.deepEqual(creates(), []);
  });

  it("saves nothing while the folder has a problem", () => {
    edit.openNewProject();
    edit.setDraftFolder("~");
    edit.saveDraft();
    assert.deepEqual(sets(), []);
    assert.equal(edit.isNewDraft(), true);
  });
});

describe("the folders on offer", () => {
  it("lists each open folder with no project once, not ones that have one", () => {
    r.data.workspaces = [
      ws("x", { directory: "/Users/jon/dev/offer-one" }),
      ws("y", { directory: "/Users/jon/dev/offer-one/" }),
      ws("z", { directory: "/Users/jon/dev/app-one" }),
    ];
    assert.deepEqual(model.folderSuggestions(), ["/Users/jon/dev/offer-one"]);
  });

  it("makes one a project in a tap, and it leaves the list", () => {
    r.data.workspaces = [ws("x", { directory: "/Users/jon/dev/offer-two" })];
    edit.openNewProject();
    edit.addSuggested("/Users/jon/dev/offer-two");
    assert.equal(sets()[0]?.[0], "projects./users/jon/dev/offer-two/");
    assert.deepEqual(creates(), []);
    assert.deepEqual(model.folderSuggestions(), []);
    assert.equal(state.editingProject(), null);
  });

  it("never offers the home folder itself", () => {
    r.data.workspaces = [ws("h", { directory: "/Users/jon" })];
    assert.deepEqual(model.folderSuggestions(), []);
    assert.equal(model.canCreateProject(r.data.workspaces[0]), false);
  });

  it("ignores a folder that is already a project, or the home folder", () => {
    sendProject("Owned", "/Users/jon/dev/owned");
    edit.addSuggested("/Users/jon");
    edit.addSuggested("/Users/jon/dev/owned");
    edit.addSuggested("/Users/jon/dev/app-one");
    edit.addSuggested("/x");
    assert.deepEqual(sets(), []);
  });
});

describe("the card chip", () => {
  it("names the project it would make", () => {
    assert.equal(
      model.makeProjectLabel(ws("c", { directory: "/Users/jon/dev/chip-card" })),
      'Make "Chip-card" a project',
    );
    assert.equal(model.makeProjectLabel(undefined), "Make a project");
  });

  it("reads its words live, so a second folder of the same name says Foo 2", () => {
    const one = ws("f1", { directory: "/Users/jon/dev/foo" });
    const two = ws("f2", { directory: "/Users/jon/work/foo" });
    r.data.workspaces = [one, two];
    // Text is swapped for one that keeps what it was given, to see the label is a closure.
    const realText = Text;
    const given: Reactive<string>[] = [];
    const g = globalThis as Record<string, unknown>;
    g.Text = (content: Reactive<string>) => {
      given.push(content);
      return realText(content);
    };
    try {
      parts.makeProjectAction(() => two);
    } finally {
      g.Text = realText;
    }
    const label = given[0];
    assert.equal(typeof label, "function");
    const read = () => (typeof label === "function" ? label() : label);
    assert.equal(read(), 'Make "Foo" a project');
    model.createProjectFrom(one);
    assert.equal(read(), 'Make "Foo 2" a project');
  });
});

describe("a project's +", () => {
  it("opens a just-sent ~ folder expanded, before the rebuild", () => {
    const k = sendProject("Rooty", "~/dev/rooty");
    model.openProjectWorkspace(k);
    assert.deepEqual(creates(), ["/Users/jon/dev/rooty"]);
  });
});
