// A card whose chat is idle on a background shell still running reads
// "Waiting 4m · 1 shell" in working blue, not Idle, once its turn is read: cmux sends
// custom sidebars no shells, so the count comes from the hook's saved copy
// (scripts/hooks/report-shell.ts). __STATE__ is set before the renderer
// import, as in helpers-saved.test.ts.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

const shell = (id: string, session: string) => ({ id, session, startedEpoch: 100 });

(globalThis as Record<string, unknown>).__STATE__ = {
  dismissed: {},
  projectOverride: {},
  projects: {},
  prs: {},
  ownPrs: {},
  ui: {},
  subagents: {},
  shells: {
    one: [shell("b1", "chat")],
    two: [shell("b1", "chat"), shell("b2", "chat")],
    other: [shell("b1", "someone-else")],
  },
};

const { installRenderer } = await import("./support/renderer.ts");
const r = installRenderer();
const { agent, ws } = await import("./support/fixtures.ts");
const { liveShellCount } = await import("../src/shared/shells.ts");
const status = await import("../src/cockpit/status.ts");
const { C } = await import("../src/cockpit/theme.ts");

const idle = () => agent("idle", { id: "chat", sinceEpoch: r.data.epoch - 240, lastActivityAt: r.data.epoch - 240 });

describe("background shells on the card", () => {
  it("counts the saved shells of the chat that started them", () => {
    const a = idle();
    assert.equal(liveShellCount(ws("one", { agents: [a] }), a), 1);
    assert.equal(liveShellCount(ws("two", { agents: [a] }), a), 2);
  });

  it("counts none for another chat, an ended one, or none", () => {
    const a = idle();
    assert.equal(liveShellCount(ws("other", { agents: [a] }), a), 0);
    const ended = agent("ended", { id: "chat" });
    assert.equal(liveShellCount(ws("one", { agents: [ended] }), ended), 0);
    assert.equal(liveShellCount(ws("none", { agents: [a] }), a), 0);
    assert.equal(liveShellCount(ws("one"), null), 0);
    assert.equal(liveShellCount(undefined, a), 0);
  });

  it("does not turn another chat's card to Waiting", () => {
    const w = ws("other", { agents: [idle()] });
    assert.match(status.statusLine(w), /^Idle/);
  });

  it("reads Waiting in working blue, with the idle age and the shell count", () => {
    const idleLine = status.statusLine(ws("none", { agents: [idle()] }));
    assert.match(idleLine, /^Idle \d+m$/);
    const w = ws("one", { agents: [idle()] });
    assert.equal(status.statusLine(w), idleLine.replace("Idle", "Waiting") + " · 1 shell");
    assert.equal(
      status.statusLine(ws("two", { agents: [idle()] })),
      idleLine.replace("Idle", "Waiting") + " · 2 shells",
    );
    const info = status.statusInfo(w);
    assert.equal(info.dot, C.blue);
    assert.equal(info.urgency, "working");
  });

  it("stays Ready while its finished turn is unread, since the shell may never end", () => {
    const w = ws("one", { unread: 2, agents: [idle()] });
    assert.equal(status.isReady(w), true);
    assert.match(status.statusLine(w), /^Finished/);
  });

  it("leaves a working chat as Working", () => {
    const w = ws("one", { agents: [agent("working", { id: "chat", sinceEpoch: r.data.epoch - 60 })] });
    assert.match(status.statusLine(w), /^Working/);
  });
});
