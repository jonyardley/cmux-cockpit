// A chat's saved "Your move" line on the cockpit's cards: shown while its
// turn end is still waiting and no prompt has come since it was saved (cmux's
// latestAt), never while the chat works or asks, with a size chip when the
// line says how big answering it is.
// __STATE__ is set before the renderer import, as in asking-saved.test.ts.

import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

(globalThis as Record<string, unknown>).__STATE__ = {
  dismissed: {},
  projectOverride: {},
  projects: {},
  prs: {},
  ownPrs: {},
  subagents: {},
  published: {},
  prOrigins: {},
  asking: { asks: { reason: "allow git push?", epoch: 1000 } },
  moves: {
    quick: { text: "the work is finished. Run /clear now.", epoch: 1000 },
    decide: { text: 'reply "1b 2a".', epoch: 1000, decisions: 2, leans: "1b 2a" },
    plain: { text: "tell me which one you meant.", epoch: 1000 },
    asks: { text: "go", epoch: 1000 },
    owned: { text: "go", epoch: 1000, session: "sessA" },
  },
  ui: {},
};

const { installRenderer } = await import("./support/renderer.ts");
const r = installRenderer();
const { agent, ws } = await import("./support/fixtures.ts");
const move = await import("../src/shared/move.ts");
const status = await import("../src/cockpit/status.ts");
const cockpit = await import("../src/cockpit/model.ts");

const waiting = (since: number, extra: Partial<Agent> = {}) =>
  agent("needs_input", { sinceEpoch: since, lastActivityAt: since, ...extra });
// Claude's Stop leaves the agent idle; cmux stamps its spell and activity then.
const stopped = (since: number, extra: Partial<Agent> = {}) =>
  agent("idle", { kind: "claude", sinceEpoch: since, lastActivityAt: since, ...extra });
// The prompt that began the turn, as cmux stamps latestAt on UserPromptSubmit.
const PROMPT_AT = 950;
// A workspace whose last prompt came before the saved moves (epoch 1000).
const at = (id: string, agents: Agent[], extra: Partial<Workspace> = {}) =>
  ws(id, { agents, latestAt: PROMPT_AT, latestMessage: "Jon, PR #120 is merged.", ...extra });

beforeEach(() => {
  r.data.epoch = 1060;
  r.data.workspaces = [];
});

describe("moveSize", () => {
  it("reads decide from decisions, then review, then quick, else nothing", () => {
    assert.equal(move.moveSize({ text: "read it", decisions: 1 }), "decide");
    assert.equal(move.moveSize({ text: "Read the draft in #142 and say go." }), "review");
    assert.equal(move.moveSize({ text: "open https://claude.ai/artifact/x" }), "review");
    assert.equal(move.moveSize({ text: "Run /clear now." }), "quick");
    assert.equal(move.moveSize({ text: "Run /clear now (see #2044)." }), "quick", "a bare #N is no clue");
    assert.equal(move.moveSize({ text: "look at the card after reload." }), "review");
    assert.equal(move.moveSize({ text: "paste this: ! gcloud auth login" }), "quick");
    assert.equal(move.moveSize({ text: "say go" }), "quick");
    assert.equal(move.moveSize({ text: "the work is finished and nothing follows." }), "quick");
    assert.equal(move.moveSize({ text: "tell me which one you meant." }), null);
    assert.equal(move.moveSize({ text: "the algorithm is good" }), null, "go only as a word");
    assert.equal(move.moveSize({ text: "check the build passes." }), null, "check is too common to mean review");
  });

  it("gives no size when nothing waits on Jon", () => {
    assert.equal(move.moveSize({ text: "PR #130 is merged; nothing waits on you." }), null);
    assert.equal(move.moveSize({ text: "done, nothing else waits on you. Read the notes if curious." }), null);
  });

  it("words the chip", () => {
    assert.equal(move.moveSizeText("quick"), "Quick");
    assert.equal(move.moveSizeText("review"), "Review");
    assert.equal(move.moveSizeText("decide", 1), "Decide");
    assert.equal(move.moveSizeText("decide", 3), "Decide · 3");
  });
});

describe("moveOf", () => {
  it("shows at idle straight after Stop, when the move is newer than the last prompt", () => {
    const w = at("quick", [stopped(1000)]);
    assert.equal(status.agentOf(w)?.status, "idle");
    assert.equal(status.moveOf(w)?.text, "the work is finished. Run /clear now.");
    assert.equal(status.cardDetail(w), "the work is finished. Run /clear now.");
    assert.ok(
      status.moveOf(at("quick", [stopped(1000)], { latestAt: 1000 + 3 })),
      "Stop in iMessage mode, slack aside",
    );
    assert.ok(status.moveOf(ws("quick", { agents: [stopped(1000)] })), "no prompt known");
  });

  it("still shows after the nudge restamps the spell and the activity a minute on", () => {
    // idle_prompt about 60s after Stop: needs_input, sinceEpoch and lastActivityAt at its arrival, latestAt untouched.
    const w = at("quick", [waiting(1060, { kind: "claude" })]);
    assert.equal(status.agentOf(w)?.status, "needs_input");
    assert.equal(status.moveOf(w)?.text, "the work is finished. Run /clear now.");
    assert.equal(status.cardDetail(w), "the work is finished. Run /clear now.");
    assert.equal(status.needsDetail(w), "the work is finished. Run /clear now.");
  });

  it("still shows when the nudge reads as idle", () => {
    const nudged = agent("needs_input", { kind: "claude", sinceEpoch: 1060, lastActivityAt: 1000 });
    const w = at("quick", [nudged]);
    assert.equal(status.agentOf(w)?.status, "idle", "the nudge reads as idle");
    assert.equal(status.moveOf(w)?.text, "the work is finished. Run /clear now.");
  });

  it("is gone once a prompt comes after it: a new turn, or an interrupted one", () => {
    // A new prompt at 1100: the move from 1000 belongs to the turn before it.
    assert.equal(status.moveOf(at("quick", [agent("working", { sinceEpoch: 1100 })], { latestAt: 1100 })), null);
    // Interrupted at 1150 with no Stop, so nothing saved a new move: still gone.
    assert.equal(status.moveOf(at("quick", [stopped(1150)], { latestAt: 1100 })), null);
    const later = agent("needs_input", { kind: "claude", sinceEpoch: 1210, lastActivityAt: 1150 });
    assert.equal(status.moveOf(at("quick", [later], { latestAt: 1100 })), null, "nudged after the interrupt");
    assert.equal(status.moveOf(at("quick", [stopped(1000)], { latestAt: 1000 + 4 })), null, "past the slack");
  });

  it("is null while it works, while it asks, once it ended, or without a saved move", () => {
    assert.equal(status.moveOf(at("quick", [agent("working", { sinceEpoch: 1000 })])), null);
    assert.equal(status.moveOf(at("asks", [waiting(1000)])), null);
    assert.equal(status.moveOf(at("quick", [agent("ended", { sinceEpoch: 1010 })])), null);
    assert.equal(status.moveOf(at("none", [stopped(1000)])), null);
  });

  it("goes only to the agent whose id is the move's session, when one has it", () => {
    const mine = waiting(1000, { id: "sessA" });
    const other = waiting(1000, { id: "sessB" });
    const w = at("owned", [mine, other]);
    assert.equal(move.waitingMove(mine, w, false)?.text, "go");
    assert.equal(move.waitingMove(other, w, false), null);
  });
});

describe("the card", () => {
  it("quotes the move over the message, on the card and the Needs you row", () => {
    const w = at("quick", [waiting(1000)]);
    assert.equal(status.cardDetail(w), "the work is finished. Run /clear now.");
    assert.equal(status.needsDetail(w), "the work is finished. Run /clear now.");
  });

  it("keeps the message once the move is stale", () => {
    const w = at("quick", [waiting(2000)], { latestAt: 1900, latestMessage: "Something new." });
    assert.equal(status.cardDetail(w), "Something new.");
  });

  it("falls back to the message, then a plain line, when there is no move", () => {
    const w = at("none", [stopped(1000)], { latestMessage: "Jon, the reply." });
    assert.equal(status.cardDetail(w), "Jon, the reply.");
    const needs = at("none", [waiting(1000)], { latestMessage: "" });
    assert.equal(status.needsDetail(needs), "Waiting for your reply");
  });

  it("leads the chips with the size, and has no size chip when the line gives no clue", () => {
    const decide = cockpit.chipsFor(at("decide", [waiting(1000)], { branch: "arch" }), true);
    assert.deepEqual(
      decide.map((c) => [c.id, c.text]),
      [
        ["size", "Decide · 2"],
        ["br", "arch"],
      ],
    );
    assert.equal(decide[0]?.size, "decide");
    const plain = cockpit.chipsFor(at("plain", [waiting(1000)]), true);
    assert.deepEqual(plain, []);
    assert.equal(status.cardDetail(at("plain", [waiting(1000)])), "tell me which one you meant.");
  });
});
