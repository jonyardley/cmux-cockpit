// A chat's last "Your move" line, from the workspace description or the
// saved moves map, whichever is newer. Whether it still waits on Jon is the
// Cockpit's call, read from the saved agents map (agents-read.test.ts).
// __STATE__ is set before the renderer import, as in agents-read.test.ts.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

(globalThis as Record<string, unknown>).__STATE__ = {
  dismissed: {},
  projectOverride: {},
  projects: {},
  prs: {},
  ownPrs: {},
  subagents: {},
  published: {},
  prOrigins: {},
  moves: { quick: { text: "the work is finished. Run /clear now.", epoch: 1000, session: "s-quick" } },
  ui: {},
};

const { installRenderer } = await import("./support/renderer.ts");
installRenderer();
const { ws } = await import("./support/fixtures.ts");
const { lastMove } = await import("../src/shared/move.ts");
const { moveDescription } = await import("../scripts/state-config.ts");

const described = (id: string, m: { text: string; epoch: number; decisions?: number }) =>
  ws(id, { description: moveDescription({ ...m, session: "s-" + id }) });

describe("a move in the workspace description", () => {
  it("shows with no saved move and no rebuild, decisions and all", () => {
    const m = lastMove(described("live", { text: 'reply "1a".', epoch: 1000, decisions: 1 }));
    assert.equal(m?.text, 'reply "1a".');
    assert.equal(m?.decisions, 1);
  });

  it("loses to a newer saved move, and wins over an older one", () => {
    assert.equal(
      lastMove(described("quick", { text: "older", epoch: 990 }))?.text,
      "the work is finished. Run /clear now.",
    );
    assert.equal(lastMove(described("quick", { text: "newer", epoch: 1010 }))?.text, "newer");
    assert.equal(
      lastMove(described("quick", { text: "newer", epoch: 1010 }))?.text,
      "newer",
      "parsed once, read again",
    );
  });

  it("is none with neither", () => {
    assert.equal(lastMove(ws("none")), undefined);
    assert.equal(lastMove(ws("none", { description: "just a description" })), undefined);
  });
});
