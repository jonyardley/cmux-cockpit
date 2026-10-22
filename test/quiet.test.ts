// A quiet agent: working, but silent for QUIET_SECS, as the agents panel's
// head status reads it.

import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { installRenderer } from "./support/renderer.ts";

const r = installRenderer();
const { agent, ws } = await import("./support/fixtures.ts");
const agents = await import("../src/agents/model.ts");
const { QUIET_SECS } = await import("../src/shared/quiet.ts");

const NOW = 1_000_000;
const working = (silentFor: number) =>
  ws("w", { agents: [agent("working", { sinceEpoch: NOW - 42 * 60, lastActivityAt: NOW - silentFor })] });
const head = (w: Workspace): string => agents.headStatus(w.agents?.[0] ?? null, w);

describe("a quiet agent", () => {
  beforeEach(() => {
    r.data.epoch = NOW;
    r.data.selectedId = null;
  });

  it("says how long it has been quiet once it passes QUIET_SECS", () => {
    assert.equal(head(working(17 * 60)), "Working 42m · quiet 17m");
  });

  it("stays plain working just under the threshold", () => {
    assert.equal(head(working(QUIET_SECS - 1)), "Working 42m");
  });

  it("holds off while a helper is running for it", () => {
    const w = working(17 * 60);
    const a = w.agents?.[0];
    if (a) a.children = [{ id: "h1", label: "explore", running: true, startedEpoch: NOW - 60 }];
    assert.equal(head(w), "Working 42m");
  });

  it("never marks an agent that is not working, or one with no activity time", () => {
    const idle = ws("i", { agents: [agent("idle", { sinceEpoch: NOW - 3600, lastActivityAt: NOW - 3600 })] });
    assert.equal(head(idle), "Idle 1h");
    const bare = ws("b", { agents: [agent("working", { sinceEpoch: NOW - 3600 })] });
    assert.equal(head(bare), "Working 1h");
  });
});
