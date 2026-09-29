// The Move to project choice in the agents sidebar: it reads the saved
// choice the cockpit wrote, so both sidebars name the same project for a
// workspace. __STATE__ is set before the renderer import, as in
// helpers-saved.test.ts.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { emptyState } from "../scripts/state-config.ts";

// The cast holds because the renderer support reads __STATE__ off globalThis by name.
(globalThis as Record<string, unknown>).__STATE__ = {
  ...emptyState(),
  projectOverride: { moved: "/dev/app-three", gone: "/dev/no-such-project" },
};

const { installRenderer } = await import("./support/renderer.ts");
const r = installRenderer();
const { agent, ws } = await import("./support/fixtures.ts");
const { projectFor, savedProjectChoice } = await import("../src/shared/projects.ts");
const m = await import("../src/agents/model.ts");

describe("projectFor", () => {
  it("takes the chosen project over the path match", () => {
    assert.equal(projectFor("/Users/coder/dev/app-one", "/dev/app-three").name, "App Three");
  });

  it("falls back to the path match without a choice, or with one naming no project", () => {
    assert.equal(projectFor("/Users/coder/dev/app-one", undefined).name, "App One");
    assert.equal(projectFor("/Users/coder/dev/app-one", "/dev/no-such-project").name, "App One");
  });

  it("reads the saved choice by workspace id", () => {
    assert.equal(savedProjectChoice("moved"), "/dev/app-three");
    assert.equal(savedProjectChoice("other"), undefined);
    assert.equal(savedProjectChoice(undefined), undefined);
    assert.equal(savedProjectChoice("toString"), undefined);
  });
});

describe("the agents sidebar honours Move to project", () => {
  it("names the chosen project in the This workspace heading", () => {
    r.data.workspaces = [
      ws("moved", { selected: true, directory: "/Users/coder/dev/app-one", agents: [agent("working")] }),
    ];
    assert.equal(m.currentHeading(), "THIS WORKSPACE · App Three");
  });

  it("keeps the path match for a workspace whose choice names no project", () => {
    r.data.workspaces = [ws("gone", { selected: true, directory: "/Users/coder/dev/app-one" })];
    assert.equal(m.currentHeading(), "THIS WORKSPACE · App One");
  });

  it("draws an agent with no status as no agent, not a crash (issue #7)", () => {
    const bare = { id: "bare" };
    r.data.workspaces = [ws("w", { selected: true, agents: [bare] })];
    assert.equal(m.dotFor(bare), m.dotFor(null));
    assert.doesNotThrow(() => m.headStatus(bare));
  });
});
