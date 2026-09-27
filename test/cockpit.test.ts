import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { installRenderer } from "./support/renderer.ts";

const r = installRenderer();
const { agent, group, ws } = await import("./support/fixtures.ts");
const model = await import("../src/cockpit/model.ts");
const drop = await import("../src/cockpit/drop.ts");
const state = await import("../src/cockpit/state.ts");
const status = await import("../src/cockpit/status.ts");
const needs = await import("../src/shared/needs.ts");
const { LANES, laneByKey } = await import("../src/cockpit/lanes.ts");
const { cardMenu, chipsFor } = await import("../src/cockpit/views/parts.ts");
const projects = await import("../src/shared/projects.ts");

// Groups mirror cmux: each lane group has a generated anchor workspace.
// Each test starts later than the last, so earlier optimistic overrides expire.
function setup(): void {
  r.data.epoch += 100;
  r.data.selectedId = null;
  r.data.groups = [
    group("g-main", "Main activity", { anchorId: "anchor-main" }),
    group("g-review", "For review", { anchorId: "anchor-review" }),
    group("g-parked", "Parked", { anchorId: "anchor-parked" }),
  ];
  r.data.workspaces = [
    // A generated anchor's title always echoes its group's name and it
    // carries no agents (model.ts's isGeneratedAnchor).
    ws("anchor-main", { title: "Main activity", group: "g-main" }),
    ws("a", { group: "g-main" }),
    ws("b", { group: "g-main" }),
    ws("anchor-review", { title: "For review", group: "g-review" }),
    ws("c", { group: "g-review" }),
    ws("anchor-parked", { title: "Parked", group: "g-parked" }),
    ws("p", { group: "g-parked" }),
    ws("u"),
  ];
  r.calls.length = 0;
  state.setMode("all");
  state.setCollapsedProjects([]);
}

const ids = () => model.flatEntries().map((e) => e.id);
const byId = (id: string) => r.data.workspaces.find((w) => w.id === id);

describe("lanes", () => {
  beforeEach(setup);

  it("maps groups to lanes by name, and ungrouped to Unsorted", () => {
    assert.equal(model.actualLaneOf(byId("a")), "main");
    assert.equal(model.actualLaneOf(byId("c")), "review");
    assert.equal(model.actualLaneOf(byId("u")), "unsorted");
    assert.equal(model.actualLaneOf(ws("x", { group: "unknown" })), "unsorted");
  });

  it("hides lane anchors from the cards", () => {
    assert.deepEqual(
      model.cardWorkspaces().map((w) => w.id),
      ["a", "b", "c", "p", "u"],
    );
  });

  it("lists every header, with Parked collapsed until touched", () => {
    assert.deepEqual(ids(), [
      "h:main",
      "a@main",
      "b@main",
      "h:review",
      "c@review",
      "h:bg",
      "h:parked",
      "h:unsorted",
      "u@unsorted",
    ]);
  });

  it("is empty outside All mode, so no drag resolves there", () => {
    state.setMode("projects");
    assert.deepEqual(model.flatEntries(), []);
  });

  it("laneByKey falls back to Unsorted and LANES ends with it", () => {
    assert.equal(LANES.at(-1)?.key, "unsorted");
    assert.equal(laneByKey("bg").name, "Background");
  });
});

// Live shape from `cmux rpc workspace.group.list` + `extension.sidebar.snapshot`
// (2026-09-26): a single-member group's anchor can be a real workspace, not a
// generated placeholder, and it must not vanish from its lane.
describe("a real workspace anchoring a single-member group", () => {
  it("hides the generated anchor but shows the real one, counted and in Needs you", () => {
    r.data.epoch += 100;
    r.data.selectedId = null;
    r.data.groups = [
      group("g-main", "Main activity", { anchorId: "gen-main" }),
      group("g-parked", "Parked", { anchorId: "real-parked" }),
    ];
    r.data.workspaces = [
      ws("gen-main", { title: "Main activity", directory: "/Users/jonyardley/Dev", group: "g-main" }),
      ws("real-parked", {
        title: "PR #155 wireless spike measurement",
        directory: "/Users/coder/dev/app-three",
        group: "g-parked",
        agents: [agent("needs_input", { sinceEpoch: 1 })],
      }),
    ];

    assert.deepEqual([...model.laneAnchorIds()], ["gen-main"]);
    assert.deepEqual(
      model.cardWorkspaces().map((w) => w.id),
      ["real-parked"],
    );
    const parked = r.data.workspaces.find((w) => w.id === "real-parked");
    if (!parked) throw new Error("fixture");
    assert.equal(model.laneOf(parked), "parked");
    assert.equal(model.laneCount("parked"), 1);
    assert.deepEqual(
      model.needsList().map((w) => w.id),
      ["real-parked"],
    );
  });

  it("still pins the real anchor's card, same as any group's anchor", () => {
    r.data.epoch += 100;
    r.data.selectedId = null;
    r.data.groups = [group("g-parked", "Parked", { anchorId: "real-parked" })];
    r.data.workspaces = [ws("real-parked", { directory: "/Users/coder/dev/app-three", group: "g-parked" })];
    assert.equal(drop.isForeignAnchor("real-parked"), true);
  });
});

describe("resolveDrop", () => {
  beforeEach(setup);

  it("takes the lane of the row above the slot", () => {
    // Without a@main: [h:main, b@main, h:review, c@review, ...]; slot 3 is under h:review.
    assert.deepEqual(drop.resolveDrop("a@main", 3), { laneKey: "review", nextRef: "c", prevRef: null });
  });

  it("files a drop at the very top into the first lane", () => {
    assert.deepEqual(drop.resolveDrop("c@review", 0), { laneKey: "main", nextRef: null, prevRef: null });
  });

  it("ignores a next card that belongs to another lane", () => {
    // Without c@review: slot 4 sits after h:review, before h:bg.
    const t = drop.resolveDrop("c@review", 4);
    assert.equal(t.laneKey, "review");
    assert.equal(t.nextRef, null);
  });
});

describe("handleMove", () => {
  beforeEach(setup);

  it("reorders before joining the new group", () => {
    drop.handleMove("a@main", 4); // after c@review
    assert.deepEqual(
      r.calls.map((c) => c.method),
      ["workspace.reorder", "workspace.group.add"],
    );
    assert.deepEqual(r.calls[1]?.params, { group_id: "g-review", workspace_id: "a" });
    // Optimistic: the card shows in its new lane before the data catches up.
    assert.equal(model.laneOf(byId("a") ?? ws("?")), "review");
  });

  it("removes from the group when dropped into Unsorted", () => {
    const slot =
      ids()
        .filter((id) => id !== "b@main")
        .indexOf("h:unsorted") + 1;
    drop.handleMove("b@main", slot);
    assert.ok(r.calls.some((c) => c.method === "workspace.group.remove" && c.params.workspace_id === "b"));
  });

  it("only reorders within the same lane", () => {
    drop.handleMove("b@main", 1); // above a
    assert.deepEqual(
      r.calls.map((c) => c.method),
      ["workspace.reorder"],
    );
    assert.deepEqual(r.calls[0]?.params, { workspace_id: "b", index: 1 });
  });

  it("ignores headers and unknown keys", () => {
    drop.handleMove("h:main", 2);
    drop.handleMove("nope", 2);
    assert.deepEqual(r.calls, []);
  });

  it("clears the drag state", () => {
    state.setDrag({ id: "a@main", index: 1 });
    drop.handleMove("a@main", 1);
    assert.equal(state.drag(), null);
  });
});

describe("foreign anchors", () => {
  beforeEach(setup);

  it("pins an anchor of a non-lane group, not a lane anchor", () => {
    r.data.groups.push(group("g-proj", "app-one", { anchorId: "a" }));
    assert.equal(drop.isForeignAnchor("a"), true);
    assert.equal(drop.isForeignAnchor("anchor-main"), false);
  });
});

describe("needs you", () => {
  beforeEach(setup);

  it("lists waiting workspaces, longest-waiting first", () => {
    const a = byId("a");
    const c = byId("c");
    if (!a || !c) throw new Error("fixture");
    a.agents = [agent("needs_input", { sinceEpoch: 200 })];
    c.agents = [agent("needs_input", { sinceEpoch: 100 })];
    assert.deepEqual(
      model.needsList().map((w) => w.id),
      ["c", "a"],
    );
  });

  it("a dismissal holds until the agent asks again", () => {
    const a = byId("a");
    if (!a) throw new Error("fixture");
    a.agents = [agent("needs_input", { sinceEpoch: 500 })];
    needs.dismissNeeds(a);
    assert.equal(status.statusOf(a), "idle");
    a.agents = [agent("needs_input", { sinceEpoch: 900 })];
    assert.equal(status.statusOf(a), "needs_input");
  });
});

describe("projects mode", () => {
  beforeEach(setup);

  it("groups by project in PROJECTS order, then Other, with an empty project's header still showing", () => {
    const a = byId("a");
    const c = byId("c");
    if (!a || !c) throw new Error("fixture");
    a.directory = "/Users/coder/dev/app-two";
    c.directory = "/Users/coder/dev/app-one";
    state.setMode("projects");
    assert.deepEqual(
      model.projectEntries().map((e) => e.id),
      [
        "p:/dev/app-one",
        "c@p",
        "p:/dev/app-two",
        "a@p",
        // app-three has no sessions: header stands, one empty row, no Other mixed in.
        "p:/dev/app-three",
        "p:/dev/app-three:empty",
        "p:other",
        "b@p",
        "p@p",
        "u@p",
      ],
    );
  });

  it("keeps a project with several matches in one group, keyed by its first match", () => {
    const a = byId("a");
    const b = byId("b");
    if (!a || !b) throw new Error("fixture");
    a.directory = "/Users/coder/dev/app-two/src";
    b.directory = "/Users/coder/.config/app-two";
    state.setMode("projects");
    const entries = model.projectEntries();
    assert.equal(entries.filter((e) => e.kind === "header" && e.project === "/dev/app-two").length, 1);
    const ids = entries.map((e) => e.id);
    const at = ids.indexOf("p:/dev/app-two");
    assert.deepEqual(ids.slice(at, at + 3), ["p:/dev/app-two", "a@p", "b@p"]);
    assert.equal(model.projectCount("/dev/app-two"), 2);
    assert.equal(model.projectByKey("/dev/app-two").name, "App Two");
  });

  it("collapses a multi-match project as one group", () => {
    const a = byId("a");
    const b = byId("b");
    if (!a || !b) throw new Error("fixture");
    a.directory = "/Users/coder/dev/app-two";
    b.directory = "/Users/coder/.config/app-two";
    state.setMode("projects");
    model.toggleProject("/dev/app-two");
    const ids = model.projectEntries().map((e) => e.id);
    assert.equal(ids.includes("a@p"), false);
    assert.equal(ids.includes("b@p"), false);
    assert.equal(ids[ids.indexOf("p:/dev/app-two") + 1], "p:/dev/app-three");
  });

  it("shows a project with no sessions as a header plus one empty row", () => {
    state.setMode("projects");
    const entries = model.projectEntries();
    const at = entries.findIndex((e) => e.kind === "header" && e.project === "/dev/app-three");
    assert.notEqual(at, -1);
    assert.deepEqual(entries[at + 1], { kind: "empty", id: "p:/dev/app-three:empty" });
  });

  it("never shows Other as a header when nothing falls into it", () => {
    for (const w of r.data.workspaces) w.directory = "/Users/coder/dev/app-one";
    state.setMode("projects");
    const entries = model.projectEntries();
    assert.equal(
      entries.some((e) => e.kind === "header" && e.project === "other"),
      false,
    );
  });
});

describe("Move to project override (issue #8)", () => {
  beforeEach(setup);

  it("has no override until one is set", () => {
    const a = byId("a");
    if (!a) throw new Error("fixture");
    assert.equal(model.hasProjectOverride(a), false);
  });

  it("overrides the path match until cleared", () => {
    const a = byId("a");
    if (!a) throw new Error("fixture");
    a.directory = "/Users/coder/dev/app-one";
    assert.equal(model.projectKey(a), "/dev/app-one");
    model.moveToProject(a, "/dev/app-two");
    assert.equal(model.projectKey(a), "/dev/app-two");
    assert.equal(model.hasProjectOverride(a), true);
    model.clearProjectOverride(a);
    assert.equal(model.projectKey(a), "/dev/app-one");
    assert.equal(model.hasProjectOverride(a), false);
  });

  it("moveToProject persists the new key, clearProjectOverride a delete", () => {
    const a = byId("a");
    if (!a) throw new Error("fixture");
    r.opened.length = 0;
    model.moveToProject(a, "/dev/app-two");
    assert.deepEqual(r.opened, ["cmux-cockpit://set?key=projectOverride.a&value=%22%2Fdev%2Fapp-two%22"]);

    r.opened.length = 0;
    model.clearProjectOverride(a);
    assert.deepEqual(r.opened, ["cmux-cockpit://set?key=projectOverride.a"]);
  });

  it("ignores a key that is not a configured project", () => {
    const a = byId("a");
    if (!a) throw new Error("fixture");
    a.directory = "/Users/coder/dev/app-one";
    model.moveToProject(a, "not-a-project");
    assert.equal(model.projectKey(a), "/dev/app-one");
    assert.equal(model.hasProjectOverride(a), false);
  });

  it("moves a workspace with no path match into a project too", () => {
    const u = byId("u");
    if (!u) throw new Error("fixture");
    assert.equal(model.projectKey(u), "other");
    model.moveToProject(u, "/dev/app-three");
    assert.equal(model.projectKey(u), "/dev/app-three");
  });

  it("regroups projectEntries by the override, not the path", () => {
    const a = byId("a");
    if (!a) throw new Error("fixture");
    a.directory = "/Users/coder/dev/app-one";
    model.moveToProject(a, "/dev/app-two");
    state.setMode("projects");
    const ids = model.projectEntries().map((e) => e.id);
    assert.equal(ids[ids.indexOf("p:/dev/app-two") + 1], "a@p");
    // app-one's header still shows (every project does), but a moved out of it.
    assert.equal(ids[ids.indexOf("p:/dev/app-one") + 1], "p:/dev/app-one:empty");
  });

  it("offers + only for a project with a root, and opens a workspace there", () => {
    // The example table gives App One a root; App Two and Other have none.
    assert.equal(model.canOpenProject("/dev/app-one"), true);
    assert.equal(model.canOpenProject("/dev/app-two"), false);
    assert.equal(model.canOpenProject("other"), false);
    model.openProjectWorkspace("/dev/app-one");
    assert.deepEqual(r.calls, [{ method: "workspace.create", params: { cwd: "~/dev/app-one", focus: true } }]);
  });

  it("does nothing when the project has no root", () => {
    model.openProjectWorkspace("/dev/app-two");
    assert.deepEqual(r.calls, []);
  });

  it("labels the card menu's new session by project, or says why it cannot", () => {
    const one = ws("one", { directory: "/Users/coder/dev/app-one" });
    const two = ws("two", { directory: "/Users/coder/dev/app-two" });
    assert.equal(model.newSessionLabel(one), "New session in App One");
    assert.equal(model.newSessionLabel(two), "New session (project has no folder)");
    assert.equal(model.newSessionLabel(byId("u")), "New session (project has no folder)");
    assert.equal(model.newSessionLabel(undefined), "New session (no workspace)");
    model.newSessionFor(two);
    model.newSessionFor(undefined);
    assert.deepEqual(r.calls, []);
    model.newSessionFor(one);
    assert.deepEqual(r.calls, [{ method: "workspace.create", params: { cwd: "~/dev/app-one", focus: true } }]);
    r.menu.length = 0;
    cardMenu(() => one);
    assert.equal(r.menu[0], "button:New session in App One");
  });
});

describe("chips", () => {
  it("shows the PR, then the branch with a dirty marker", () => {
    const chips = chipsFor(
      ws("x", { pr: { number: 7, status: "open", url: "https://x/7" }, branch: "feat", dirty: true }),
      true,
    );
    assert.deepEqual(
      chips.map((c) => c.text),
      ["#7", "feat •"],
    );
    assert.equal(chipsFor(ws("y", { branch: "feat" }), false).length, 0);
  });
});

describe("prTextColor", () => {
  const pr = (health: "failing" | "running" | "ready" | "quiet", s: PrStatus = "open") => ({
    number: 1,
    status: s,
    url: undefined,
    health,
    draft: false,
    tag: "#1",
    text: "#1",
  });

  it("keeps the density's colour while the PR is quiet or absent", () => {
    assert.equal(status.prTextColor(undefined, "#111111"), "#111111");
    assert.equal(status.prTextColor(pr("quiet"), "#111111"), "#111111");
    assert.equal(status.prTextColor(pr("quiet", "merged"), "#111111"), "#111111");
  });

  it("takes the health's chip colour otherwise, running in blue", () => {
    assert.equal(status.prTextColor(pr("failing"), "#111111"), "#9E2F27");
    assert.equal(status.prTextColor(pr("running"), "#111111"), "#2F5690");
    assert.equal(status.prTextColor(pr("ready"), "#111111"), "#2F4A1C");
  });
});

describe("lane markers", () => {
  it("are all distinct", () => {
    assert.equal(new Set(LANES.map((l) => l.color)).size, LANES.length);
  });
});

// cmux drops submenus from a context menu, so every item must sit at the
// top level (issue #8's "Move to project" never showed). renderer.d.ts no
// longer declares Menu(), so the compiler refuses a submenu anywhere.
describe("card menu", () => {
  beforeEach(setup);

  it("offers every lane and project at the top level, ticking the current ones", () => {
    const { PROJECTS } = projects;
    model.clearProjectOverride(byId("a"));
    r.menu.length = 0;
    cardMenu(() => byId("a"));
    assert.ok(r.menu.includes("button:✓ Lane: Main activity"));
    for (const lane of LANES.filter((l) => l.key !== "main")) assert.ok(r.menu.includes("button:Lane: " + lane.name));
    for (const p of PROJECTS) assert.ok(r.menu.includes("button:Project: " + p.name));
    // "a" has no directory, so it falls in Other: only its lane is ticked.
    assert.deepEqual(
      r.menu.filter((m) => m.startsWith("button:✓ ")),
      ["button:✓ Lane: Main activity"],
    );
    assert.ok(r.menu.includes("button:No project override set"));
  });

  it("offers to clear an override once one is set", () => {
    const { PROJECTS, projectId } = projects;
    const first = PROJECTS[0];
    assert.ok(first);
    model.moveToProject(byId("a"), projectId(first));
    r.menu.length = 0;
    cardMenu(() => byId("a"));
    assert.ok(r.menu.includes("button:✓ Project: " + first.name));
    assert.ok(r.menu.includes("button:Clear project override"));
    model.clearProjectOverride(byId("a"));
  });
});

describe("new project from a card (issue #9)", () => {
  beforeEach(setup);

  it("offers it on a card whose folder matches no project, and sends the new project", () => {
    const loose = ws("loose", { group: "g-main", directory: "/Users/jon/dev/scratch" });
    r.data.workspaces = [...r.data.workspaces, loose];
    r.menu.length = 0;
    cardMenu(() => loose);
    assert.ok(r.menu.includes("button:New project from this folder"));
    assert.ok(r.menu.includes("button:Next colour (sidebar-made projects only)"));
    r.opened.length = 0;
    model.createProjectFrom(loose);
    const url = new URL(r.opened[0] ?? "");
    assert.equal(url.searchParams.get("key"), "projects./users/jon/dev/scratch/");
    // Waiting on the rebuild: a second tap must not resend it under "Scratch 2".
    assert.equal(model.canCreateProject(loose), false);
    model.createProjectFrom(loose);
    assert.equal(r.opened.length, 1);
    assert.equal(JSON.parse(url.searchParams.get("value") ?? "").name, "Scratch");
  });

  it("counts a project sent but not built yet, so a second folder gets a fresh name and colour", () => {
    const one = ws("one", { directory: "/a/app" });
    const two = ws("two", { directory: "/b/app" });
    r.opened.length = 0;
    model.createProjectFrom(one);
    model.createProjectFrom(two);
    const [a, b] = r.opened.map((u) => JSON.parse(new URL(u).searchParams.get("value") ?? ""));
    assert.equal(a.name, "App");
    assert.equal(b.name, "App 2");
    assert.notEqual(a.color, b.color);
  });

  it("is not offered to a card moved into a project by hand", () => {
    const first = projects.PROJECTS[0];
    assert.ok(first);
    const moved = ws("moved", { directory: "/Users/jon/dev/elsewhere" });
    r.data.workspaces = [...r.data.workspaces, moved];
    model.moveToProject(moved, projects.projectId(first));
    assert.equal(model.canCreateProject(moved), false);
    model.clearProjectOverride(moved);
    assert.equal(model.canCreateProject(moved), true);
  });

  it("does nothing for a card already in a project, or with no folder", () => {
    const first = projects.PROJECTS[0];
    assert.ok(first);
    const matched = ws("matched", { directory: "/Users/jon" + projects.projectId(first) });
    r.opened.length = 0;
    for (const w of [matched, ws("nofolder"), undefined]) {
      assert.equal(model.canCreateProject(w), false);
      model.createProjectFrom(w);
      model.cycleProjectColor(w);
      model.removeProject(w);
    }
    assert.deepEqual(r.opened, []);
    r.menu.length = 0;
    cardMenu(() => matched);
    assert.ok(r.menu.includes("button:New project (folder has one, or none)"));
  });
});

// Each rebuild reloads the sidebar, so the view and the folds go out to the
// saved state as they change (state.ts seeds them back; test/ui-seed.test.ts).
describe("saving the view and folds", () => {
  beforeEach(setup);

  const sent = (): unknown[] =>
    r.opened.map((u) => {
      const q = new URL(u).searchParams;
      const v = q.get("value");
      return [q.get("key"), v === null ? null : JSON.parse(v)];
    });

  it("saves a switch between All and Projects, and not a tap on the one already shown", () => {
    r.opened.length = 0;
    model.chooseMode("all");
    assert.deepEqual(r.opened, []);
    model.chooseMode("projects");
    assert.equal(state.mode(), "projects");
    assert.deepEqual(sent(), [["ui.mode", "projects"]]);
  });

  it("saves every fold at once when a lane or project is toggled", () => {
    r.opened.length = 0;
    model.toggleLane(laneByKey("unsorted"));
    model.toggleProject("/dev/app-two");
    const last = sent().at(-1);
    assert.ok(Array.isArray(last));
    assert.equal(last[0], "ui.collapsed");
    assert.equal(last[1]["lane:unsorted"], 1);
    assert.equal(last[1]["project:/dev/app-two"], 1);
  });

  it("drops folds on projects that are gone, and sorts the rest", () => {
    state.setCollapsedProjects(["/dev/gone", "/dev/app-two", "/dev/app-one"]);
    r.opened.length = 0;
    model.toggleLane(laneByKey("unsorted"));
    const last = sent().at(-1);
    assert.ok(Array.isArray(last));
    const keys = Object.keys(last[1]);
    assert.equal(keys.includes("project:/dev/gone"), false);
    assert.deepEqual(keys, [...keys].sort());
    assert.ok(keys.includes("project:/dev/app-one") && keys.includes("project:/dev/app-two"));
  });

  it("marks a lane that starts folded as touched once it is opened", () => {
    const parked = laneByKey("parked");
    r.opened.length = 0;
    if (model.isCollapsed(parked)) model.toggleLane(parked);
    const last = sent().at(-1);
    assert.ok(Array.isArray(last));
    assert.equal(last[1]["lane:parked"], 0);
  });
});
