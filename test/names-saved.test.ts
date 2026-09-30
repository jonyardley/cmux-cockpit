// Agent rows named from the saved session names: scripts/hooks/report-rename.ts
// records one per Claude Code session, keyed by the session id cmux sends as
// the agent's id. __STATE__ is set before the renderer import, as in
// helpers-saved.test.ts.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

(globalThis as Record<string, unknown>).__STATE__ = {
  dismissed: {},
  projectOverride: {},
  projects: {},
  prs: {},
  ownPrs: {},
  subagents: {},
  ui: {},
  names: {
    named: { name: "Real names on agent rows", from: "prompt" },
    renamed: { name: "Design Review", from: "title" },
  },
};

const { installRenderer } = await import("./support/renderer.ts");
const r = installRenderer();
const { agent, ws } = await import("./support/fixtures.ts");
const m = await import("../src/agents/model.ts");

const labels = (): string[] => m.agentRows().map((e) => e.label);

describe("saved session names on agent rows", () => {
  it("takes the saved name over cmux's title, and cmux's title over a numbered fallback", () => {
    r.data.workspaces = [
      ws("w", {
        selected: true,
        agents: [
          agent("working", { id: "named", name: "Claude", title: "First message" }),
          agent("idle", { id: "renamed", name: "Claude", lastActivityAt: 100 }),
          agent("idle", { name: "Claude", title: "Fix the poller", lastActivityAt: 50 }),
          agent("idle", { name: "Claude", lastActivityAt: 10 }),
        ],
      }),
    ];
    assert.deepEqual(labels(), ["Real names on agent rows", "Design Review", "Fix the poller", "Claude"]);
  });

  it("numbers only the agents left without a name", () => {
    r.data.epoch += 1;
    r.data.workspaces = [
      ws("w", {
        selected: true,
        agents: [
          agent("working", { id: "named", name: "Claude" }),
          agent("idle", { name: "Claude", lastActivityAt: 100 }),
          agent("idle", { name: "Claude", lastActivityAt: 50 }),
        ],
      }),
    ];
    assert.deepEqual(labels(), ["Real names on agent rows", "Claude 1", "Claude 2"]);
  });
});
