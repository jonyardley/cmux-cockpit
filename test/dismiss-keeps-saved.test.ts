// The agents panel's dismiss writes the workspace's whole dismissal entry,
// which the native Cockpit shares, so it keeps the keys that are no agent
// here: the Cockpit's CI and Ostinato waits. __STATE__ is set before the
// renderer import, as in asking-saved.test.ts.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

(globalThis as Record<string, unknown>).__STATE__ = {
  dismissed: { w: { ci: 300, ostinato: 400 } },
  projectOverride: {},
  projects: {},
  prs: {},
  ownPrs: {},
  subagents: {},
  published: {},
  asking: {},
  moves: {},
  poll: {},
  ui: {},
};

const { installRenderer } = await import("./support/renderer.ts");
const r = installRenderer();
const { agent, ws } = await import("./support/fixtures.ts");
const { dismissNeeds } = await import("../src/shared/needs.ts");

describe("dismissNeeds with the Cockpit's saved dismissals", () => {
  it("keeps the CI and Ostinato keys beside the agent it dismisses", () => {
    r.data.epoch = 1000;
    r.opened.length = 0;
    const asker = agent("needs_input", { sinceEpoch: 500 });
    dismissNeeds(ws("w", { agents: [asker] }));
    const saved = { ci: 300, ostinato: 400, [asker.id]: 500 };
    assert.deepEqual(r.opened, [
      `cmux-cockpit://set?key=dismissed.w&value=${encodeURIComponent(JSON.stringify(saved))}`,
    ]);
  });
});
