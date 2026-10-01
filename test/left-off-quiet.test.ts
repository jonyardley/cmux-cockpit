// A quiet agent (working, but silent for QUIET_SECS) and the "You:" line on
// cards in the lanes you come back to.

import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { installRenderer } from "./support/renderer.ts";

const r = installRenderer();
const { agent, group, ws } = await import("./support/fixtures.ts");
const model = await import("../src/cockpit/lane-entries.ts");
const status = await import("../src/cockpit/status.ts");
const { promptText } = await import("../src/shared/text.ts");
const agents = await import("../src/agents/model.ts");
const { QUIET_SECS } = await import("../src/shared/quiet.ts");
const { C } = await import("../src/cockpit/theme.ts");

const NOW = 1_000_000;
const working = (silentFor: number) =>
  ws("w", { agents: [agent("working", { sinceEpoch: NOW - 42 * 60, lastActivityAt: NOW - silentFor })] });

describe("a quiet agent", () => {
  beforeEach(() => {
    r.data.epoch = NOW;
    r.data.selectedId = null;
  });

  it("says how long it has been quiet once it passes QUIET_SECS", () => {
    assert.equal(status.statusLine(working(17 * 60)), "Working 42m · quiet 17m");
  });

  it("draws a hollow blue dot with no halo, and keeps the working words' colour", () => {
    const info = status.statusInfo(working(QUIET_SECS));
    assert.equal(info.dot, null);
    assert.equal(info.ring, C.blue);
    assert.equal(info.halo, "clear");
    assert.equal(info.text, status.statusInfo(working(0)).text);
  });

  it("stays plain working just under the threshold", () => {
    const w = working(QUIET_SECS - 1);
    assert.equal(status.statusLine(w), "Working 42m");
    assert.equal(status.statusInfo(w).dot, C.blue);
  });

  it("holds off while a helper is running for it", () => {
    const w = working(17 * 60);
    const a = w.agents?.[0];
    if (a) a.children = [{ id: "h1", label: "explore", running: true, startedEpoch: NOW - 60 }];
    assert.equal(status.statusLine(w), "Working 42m");
  });

  it("reads the same in the agents panel's head status", () => {
    const w = working(17 * 60);
    assert.equal(agents.headStatus(w.agents?.[0] ?? null, w), "Working 42m · quiet 17m");
  });

  it("never marks an agent that is not working, or one with no activity time", () => {
    const idle = ws("i", { agents: [agent("idle", { sinceEpoch: NOW - 3600, lastActivityAt: NOW - 3600 })] });
    assert.equal(status.statusLine(idle), "Idle 1h");
    const bare = ws("b", { agents: [agent("working", { sinceEpoch: NOW - 3600 })] });
    assert.equal(status.statusLine(bare), "Working 1h");
  });
});

describe("where you left off", () => {
  beforeEach(() => {
    r.data.epoch = NOW;
    r.data.groups = [group("g-main", "Main activity"), group("g-bg", "Background"), group("g-parked", "Parked")];
  });

  it("shows on Background and Parked cards only", () => {
    assert.equal(model.showsLeftOff(ws("a", { group: "g-bg" })), true);
    assert.equal(model.showsLeftOff(ws("b", { group: "g-parked" })), true);
    assert.equal(model.showsLeftOff(ws("c", { group: "g-main" })), false);
    assert.equal(model.showsLeftOff(ws("d")), false);
  });

  it("says your last prompt after You:", () => {
    assert.equal(
      status.leftOffText(ws("a", { latestPrompt: "tighten slides 9 to 12" })),
      "You: tighten slides 9 to 12",
    );
  });

  it("clips a long prompt to one line's worth", () => {
    const t = status.leftOffText(ws("a", { latestPrompt: "word ".repeat(60) }));
    assert.equal(t.length, "You: ".length + 90);
    assert.ok(t.endsWith("…"), t);
  });

  it("is empty with no prompt, or a harness turn before any prompt", () => {
    assert.equal(status.leftOffText(ws("none")), "");
    const handBack = "<task-notification>the helper finished";
    assert.equal(promptText(ws("fresh", { latestPrompt: handBack })), "");
    assert.equal(status.leftOffText(ws("fresh", { latestPrompt: handBack })), "");
  });

  it("keeps the last real prompt through a harness turn, as the Asked line does", () => {
    assert.equal(status.leftOffText(ws("kept", { latestPrompt: "refactor the bridge" })), "You: refactor the bridge");
    const handBack = ws("kept", { latestPrompt: "[Subagent hand-back] done" });
    assert.equal(status.leftOffText(handBack), "You: refactor the bridge");
  });
});
