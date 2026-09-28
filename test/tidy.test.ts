// The tidy strip: merged worktrees grouped by repo, and the close-out typed
// (never run) into a new workspace. __PROJECTS__, __COCKPIT_ROOT__ and
// __STATE__ are set before the renderer import, since each is read at load.

import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

const g = globalThis as Record<string, unknown>;
g.__PROJECTS__ = [
  { match: "/dev/app", name: "App", color: "#D97757", icon: "star.fill", root: "/Users/jon/Dev/app" },
  {
    match: "/.config/cockpit",
    name: "Cockpit",
    color: "#6A9BCC",
    icon: "cube.fill",
    root: "/Users/jon/.config/cockpit",
  },
  { match: "/dev/loose", name: "Loose", color: "#788C5D", icon: "leaf.fill" },
];
// Cased differently from the table, as git may spell it: still the cockpit.
g.__COCKPIT_ROOT__ = "/Users/Jon/.config/cockpit/";

const merged = { url: "https://github.com/o/r/pull/1", number: 1, status: "merged", checks: [] };
g.__STATE__ = {
  dismissed: {},
  projectOverride: {},
  projects: {},
  prs: {
    appA: { ...merged, branch: "feat-a" },
    appB: { ...merged, branch: "it's" },
    appDup: { ...merged, branch: "feat-a" },
    cockpit: { ...merged, branch: "strip" },
    appMain: { ...merged, branch: "main-feature" },
    open: { ...merged, status: "open", branch: "still-open" },
    loose: { ...merged, branch: "no-root" },
    noBranch: { ...merged, branch: "" },
    inMain: { ...merged, branch: "in-main" },
    sibling: { ...merged, branch: "sibling" },
  },
  ownPrs: {},
  ui: {},
};

const { installRenderer } = await import("./support/renderer.ts");
const r = installRenderer();
const { ws } = await import("./support/fixtures.ts");
const tidy = await import("../src/cockpit/tidy.ts");

const allCards = (): Workspace[] => [
  ws("appA", { directory: "/Users/jon/Dev/app-worktrees/feat-a", branch: "feat-a" }),
  ws("appB", { directory: "/Users/jon/Dev/app-worktrees/its", branch: "it's" }),
  ws("appDup", { directory: "/Users/jon/Dev/app-worktrees/feat-a/sub", branch: "feat-a" }),
  ws("cockpit", { directory: "/Users/jon/.config/cockpit-worktrees/strip", branch: "strip" }),
  ws("appMain", { directory: "/Users/jon/Dev/app/", branch: "main-feature" }),
  ws("open", { directory: "/Users/jon/Dev/app-worktrees/still-open", branch: "still-open" }),
  ws("loose", { directory: "/Users/jon/Dev/loose-worktrees/x", branch: "no-root" }),
  ws("noBranch", { directory: "/Users/jon/Dev/app-worktrees/y" }),
  ws("inMain", { directory: "/Users/jon/Dev/app/src", branch: "in-main" }),
  ws("sibling", { directory: "/Users/jon/Dev/app-show-and-tell", branch: "sibling" }),
  // cmux's own list: the branch merged once, then took a new open PR.
  ws("reused", {
    directory: "/Users/jon/Dev/app-worktrees/reused",
    branch: "reused",
    prs: [
      { status: "merged", branch: "reused" },
      { status: "open", branch: "reused" },
    ],
  }),
];

beforeEach(() => {
  r.data.epoch += 100;
  r.data.groups = [];
  r.data.workspaces = allCards();
  r.calls.length = 0;
});

describe("tidyRepos", () => {
  it("groups merged worktrees by repo, the cockpit's first, each branch once", () => {
    assert.deepEqual(tidy.tidyRepos(), [
      { root: "/Users/jon/.config/cockpit", branches: ["strip"] },
      { root: "/Users/jon/Dev/app", branches: ["feat-a", "it's"] },
    ]);
  });

  it("leaves out open PRs, anything outside <root>-worktrees, rootless projects and branchless cards", () => {
    const listed = tidy.tidyBranches();
    for (const b of ["still-open", "main-feature", "no-root", "", "in-main", "sibling", "reused"]) {
      assert.ok(!listed.includes(b), b);
    }
  });

  it("is empty when nothing has merged", () => {
    r.data.workspaces = allCards().filter((w) => w.id === "open");
    assert.deepEqual(tidy.tidyRepos(), []);
  });
});

describe("tidyCommand", () => {
  it("gives the cockpit the full close-out and other repos only the removal", () => {
    assert.equal(
      tidy.tidyCommand(tidy.tidyRepos()),
      "git -C /Users/jon/.config/cockpit pull --ff-only && npm --prefix /Users/jon/.config/cockpit run build" +
        " && cmux automation reload && cmux sidebar reload && wt -C /Users/jon/.config/cockpit remove strip" +
        " ; wt -C /Users/jon/Dev/app remove feat-a 'it'\\''s'",
    );
  });

  it("quotes only what zsh would split or expand", () => {
    assert.equal(tidy.shellQuote("feature/x-1.2"), "feature/x-1.2");
    assert.equal(tidy.shellQuote("/a b"), "'/a b'");
    assert.equal(tidy.shellQuote("$HOME"), "'$HOME'");
    assert.equal(tidy.shellQuote("=wt"), "'=wt'");
  });
});

describe("tidy", () => {
  it("opens a workspace in the first repo with the command typed and no Enter", () => {
    tidy.tidy();
    assert.equal(r.calls.length, 1);
    const call = r.calls[0];
    assert.equal(call?.method, "workspace.create");
    assert.equal(call?.params.cwd, "/Users/jon/.config/cockpit");
    assert.equal(call?.params.focus, true);
    const input = String(call?.params.initial_input);
    assert.equal(input, tidy.tidyCommand(tidy.tidyRepos()));
    assert.ok(!/[\r\n]/.test(input));
  });

  it("ignores a second tap until the workspace it opened appears", () => {
    tidy.tidy();
    assert.equal(r.calls.length, 0);
    r.data.workspaces = [...allCards(), ws("opened-1")];
    tidy.tidy();
    assert.equal(r.calls.length, 1);
  });

  it("opens in another repo when the cockpit has nothing merged", () => {
    r.data.workspaces = [...allCards().filter((w) => w.id === "appA"), ws("opened-2")];
    tidy.tidy();
    assert.equal(r.calls[0]?.params.cwd, "/Users/jon/Dev/app");
    assert.equal(r.calls[0]?.params.initial_input, "wt -C /Users/jon/Dev/app remove feat-a");
  });

  it("does nothing when nothing has merged", () => {
    r.data.workspaces = [];
    tidy.tidy();
    assert.equal(r.calls.length, 0);
  });
});
