// A chat's saved "Your move" line on the cockpit's cards: shown while its
// turn end is still waiting and cmux's latest message is the reply it came
// from, never once the chat works again or while it is asking, with a size
// chip when the line says how big answering it is.
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
    quick: { text: "the work is finished. Run /clear now.", epoch: 1000, head: "jonpr120ismerged" },
    decide: { text: 'reply "1b 2a".', epoch: 1000, decisions: 2, leans: "1b 2a", head: "jonpr120ismerged" },
    plain: { text: "tell me which one you meant.", epoch: 1000, head: "jonpr120ismerged" },
    asks: { text: "go", epoch: 1000, head: "jonpr120ismerged" },
    owned: { text: "go", epoch: 1000, session: "sessA", head: "jonpr120ismerged" },
    headless: { text: "go", epoch: 1000 },
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
// The reply the saved moves came from, as cmux sends it: markdown kept, cut.
const REPLY = "**Jon**, PR #120 is merged and the cleanup is finished.";
// A workspace whose latest message is that reply.
const at = (id: string, agents: Agent[], extra: Partial<Workspace> = {}) =>
  ws(id, { agents, latestMessage: REPLY, ...extra });

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
  it("is the saved move while the latest message is the reply it came from", () => {
    assert.equal(status.moveOf(at("quick", [waiting(1000)]))?.text, "the work is finished. Run /clear now.");
    assert.ok(
      status.moveOf(at("quick", [waiting(1000)], { latestMessage: "Jon, PR #120 is merged." })),
      "markdown gone",
    );
  });

  it("still shows when the nudge restamps both the spell and the activity a minute on", () => {
    // The observed case: cmux stamps sinceEpoch and lastActivityAt at the nudge.
    const w = at("quick", [waiting(1060)]);
    assert.equal(status.moveOf(w)?.text, "the work is finished. Run /clear now.");
    assert.equal(status.cardDetail(w), "the work is finished. Run /clear now.");
    assert.equal(status.needsDetail(w), "the work is finished. Run /clear now.");
  });

  it("is null once the latest message is another reply", () => {
    assert.equal(status.moveOf(at("quick", [waiting(1060)], { latestMessage: "Jon, the next turn." })), null);
    assert.equal(status.moveOf(at("quick", [waiting(1060)], { latestMessage: "" })), null);
    assert.equal(status.moveOf(ws("quick", { agents: [waiting(1060)] })), null, "no message");
  });

  it("is null while it works, while it asks, without a saved move, or saved without a head", () => {
    assert.equal(status.moveOf(at("quick", [agent("working", { sinceEpoch: 1000 })])), null);
    assert.equal(status.moveOf(at("asks", [waiting(1000)])), null);
    assert.equal(status.moveOf(at("none", [waiting(1000)])), null);
    assert.equal(status.moveOf(at("headless", [waiting(1000)])), null);
  });

  it("still shows after the idle nudge turns the agent idle and restarts its spell", () => {
    // The nudge lands 60s on: cmux says needs_input from then, with no new activity.
    const nudged = agent("needs_input", { kind: "claude", sinceEpoch: 1060, lastActivityAt: 1000 });
    const w = at("quick", [nudged]);
    assert.equal(status.agentOf(w)?.status, "idle", "the nudge reads as idle");
    assert.equal(status.moveOf(w)?.text, "the work is finished. Run /clear now.");
    assert.equal(status.cardDetail(w), "the work is finished. Run /clear now.");
  });

  it("is gone once the agent works again and ends on a new reply, even when it reads as a nudge", () => {
    const working = agent("working", { kind: "claude", sinceEpoch: 1100, lastActivityAt: 1100 });
    assert.equal(status.moveOf(at("quick", [working])), null);
    const later = agent("needs_input", { kind: "claude", sinceEpoch: 1160, lastActivityAt: 1100 });
    assert.equal(status.moveOf(at("quick", [later], { latestMessage: "Jon, a later reply." })), null);
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
    const w = ws("quick", { agents: [waiting(2000)], latestMessage: "Something new." });
    assert.equal(status.cardDetail(w), "Something new.");
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
