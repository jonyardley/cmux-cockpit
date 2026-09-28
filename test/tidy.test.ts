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
g.__COCKPIT_ROOT__ = "/Users/jon/.config/cockpit";

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

  it("leaves out open PRs, the main checkout, rootless projects and branchless cards", () => {
    const listed = tidy.tidyBranches();
    for (const b of ["still-open", "main-feature", "no-root", ""]) assert.ok(!listed.includes(b), b);
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

  it("opens in another repo when the cockpit has nothing merged", () => {
    r.data.workspaces = allCards().filter((w) => w.id === "appA");
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
