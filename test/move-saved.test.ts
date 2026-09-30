// A chat's saved "Your move" line on the cockpit's cards: shown while its
// turn end is still waiting and no prompt has come since it was saved (cmux's
// latestAt), only on the Claude session that saved it, never while the chat
// works or asks, with a size chip when the line says how big answering it is.
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
  asking: { asks: { reason: "allow git push?", epoch: 1000 }, quietAsks: { reason: "allow git push?", epoch: 1060 } },
  moves: {
    quick: { text: "the work is finished. Run /clear now.", epoch: 1000, session: "s-quick" },
    decide: { text: 'reply "1b 2a".', epoch: 1000, session: "s-decide", decisions: 2, leans: "1b 2a" },
    plain: { text: "tell me which one you meant.", epoch: 1000, session: "s-plain" },
    asks: { text: "go", epoch: 1000, session: "s-asks" },
    owned: { text: "go", epoch: 1000, session: "sessA" },
    bare: { text: "go", epoch: 1000 },
    quiet: { text: "CI is running on #2171. I report when it lands.", epoch: 1000, session: "s-quiet", idle: true },
    legacy: { text: "nothing. Waiting until CI lands.", epoch: 1000, session: "s-legacy" },
    quietAsks: { text: "CI is running.", epoch: 1000, session: "s-quietAsks", idle: true },
  },
  ui: {},
};

const { installRenderer } = await import("./support/renderer.ts");
const r = installRenderer();
const { agent, ws } = await import("./support/fixtures.ts");
const move = await import("../src/shared/move.ts");
const needs = await import("../src/shared/needs.ts");
const status = await import("../src/cockpit/status.ts");
const cockpit = await import("../src/cockpit/model.ts");

// The Claude session that saved workspace `id`'s move, as cmux reports it once hooked.
const own = (id: string): Partial<Agent> => ({ id: "s-" + id, kind: "claude" });
// The nudge about 60s after Stop: needs_input, with sinceEpoch and lastActivityAt stamped at its arrival.
const waiting = (id: string, since: number, extra: Partial<Agent> = {}) =>
  agent("needs_input", { ...own(id), sinceEpoch: since, lastActivityAt: since, ...extra });
// Claude's Stop leaves the agent idle; cmux stamps its spell and activity then.
const stopped = (id: string, since: number, extra: Partial<Agent> = {}) =>
  agent("idle", { ...own(id), sinceEpoch: since, lastActivityAt: since, ...extra });
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
    assert.equal(move.moveSize({ text: "CI is running; say go if you want it sooner.", idle: true }), null);
    assert.equal(move.moveSize({ text: "nothing. Waiting until CI lands." }), null);
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
    const w = at("quick", [stopped("quick", 1000)]);
    assert.equal(status.agentOf(w)?.status, "idle");
    assert.equal(status.moveOf(w)?.text, "the work is finished. Run /clear now.");
    assert.equal(status.cardDetail(w), "the work is finished. Run /clear now.");
    assert.ok(
      status.moveOf(at("quick", [stopped("quick", 1000)], { latestAt: 1000 + 3 })),
      "Stop in iMessage mode, slack aside",
    );
  });

  it("shows none when no prompt is known, since the move's age cannot be told", () => {
    assert.equal(status.moveOf(ws("quick", { agents: [stopped("quick", 1000)] })), null, "no latestAt");
    assert.equal(status.moveOf(ws("quick", { agents: [stopped("quick", 1000)], latestAt: 0 })), null, "latestAt 0");
  });

  it("still shows after the nudge restamps the spell and the activity a minute on", () => {
    // idle_prompt about 60s after Stop: needs_input, sinceEpoch and lastActivityAt at its arrival, latestAt untouched.
    const w = at("quick", [waiting("quick", 1060)]);
    assert.equal(status.agentOf(w)?.status, "needs_input");
    assert.equal(status.moveOf(w)?.text, "the work is finished. Run /clear now.");
    assert.equal(status.cardDetail(w), "the work is finished. Run /clear now.");
    assert.equal(status.needsDetail(w), "the work is finished. Run /clear now.");
  });

  it("is gone once a prompt comes after it: a new turn, or an interrupted one", () => {
    // A new prompt at 1100 while the agent still reads as at its turn end: the move from 1000 is the turn before's.
    assert.equal(status.moveOf(at("quick", [stopped("quick", 1000)], { latestAt: 1100 })), null);
    // Interrupted at 1150 with no Stop, so nothing saved a new move: still gone.
    assert.equal(status.moveOf(at("quick", [stopped("quick", 1150)], { latestAt: 1100 })), null);
    assert.equal(
      status.moveOf(at("quick", [waiting("quick", 1210)], { latestAt: 1100 })),
      null,
      "nudged after the interrupt",
    );
    assert.equal(status.moveOf(at("quick", [stopped("quick", 1000)], { latestAt: 1000 + 4 })), null, "past the slack");
  });

  it("is null while it works, while it asks, once it ended, or without a saved move", () => {
    assert.equal(status.moveOf(at("quick", [agent("working", { ...own("quick"), sinceEpoch: 1000 })])), null);
    assert.equal(status.moveOf(at("asks", [waiting("asks", 1000)])), null);
    assert.equal(status.moveOf(at("quick", [agent("ended", { ...own("quick"), sinceEpoch: 1010 })])), null);
    assert.equal(status.moveOf(at("none", [stopped("none", 1000)])), null);
  });
});

describe("whose move it is", () => {
  const claude = (id: string, extra: Partial<Agent> = {}) =>
    agent("needs_input", { id, kind: "claude", sinceEpoch: 1000, lastActivityAt: 1000, ...extra });

  it("goes only to the Claude agent whose id is the move's session", () => {
    const mine = claude("sessA");
    const other = claude("sessB");
    const w = at("owned", [mine, other]);
    assert.equal(move.waitingMove(mine, w, false)?.text, "go");
    assert.equal(move.waitingMove(other, w, false), null);
  });

  it("shows none for a move saved with no session", () => {
    const a = claude("sessA");
    assert.equal(move.waitingMove(a, at("bare", [a]), false), null);
  });

  it("shows none to a new session in the same workspace: /clear, a relaunch, --resume", () => {
    const fresh = claude("sessNew");
    assert.equal(move.waitingMove(fresh, at("owned", [fresh]), false), null);
  });

  it("shows none while the agent is still on its pending-claude alias", () => {
    const pending = claude("pending-claude-1");
    assert.equal(move.waitingMove(pending, at("owned", [pending]), false), null);
  });

  it("shows none to a codex agent, even one carrying the session as its id", () => {
    const codex = claude("sessA", { kind: "codex" });
    assert.equal(move.waitingMove(codex, at("owned", [codex]), false), null);
    const unknown = agent("needs_input", { id: "sessA", sinceEpoch: 1000, lastActivityAt: 1000 });
    assert.equal(move.waitingMove(unknown, at("owned", [unknown]), false), null, "no kind reported");
  });
});

describe("the card", () => {
  it("quotes the move over the message, on the card and the Needs you row", () => {
    const w = at("quick", [waiting("quick", 1000)]);
    assert.equal(status.cardDetail(w), "the work is finished. Run /clear now.");
    assert.equal(status.needsDetail(w), "the work is finished. Run /clear now.");
  });

  it("keeps the message once the move is stale", () => {
    const w = at("quick", [waiting("quick", 2000)], { latestAt: 1900, latestMessage: "Something new." });
    assert.equal(status.cardDetail(w), "Something new.");
  });

  it("falls back to the message, then a plain line, when there is no move", () => {
    const w = at("none", [stopped("none", 1000)], { latestMessage: "Jon, the reply." });
    assert.equal(status.cardDetail(w), "Jon, the reply.");
    const needs = at("none", [waiting("none", 1000)], { latestMessage: "" });
    assert.equal(status.needsDetail(needs), "Waiting for your reply");
  });

  it("leads the chips with the size, and has no size chip when the line gives no clue", () => {
    const decide = cockpit.chipsFor(at("decide", [waiting("decide", 1000)], { branch: "arch" }), true);
    assert.deepEqual(
      decide.map((c) => [c.id, c.id === "pr" ? c.tag : c.text]),
      [
        ["size", "Decide · 2"],
        ["br", "arch"],
      ],
    );
    const [size] = decide;
    assert.equal(size?.id === "pr" ? null : size?.size, "decide");
    const plain = cockpit.chipsFor(at("plain", [waiting("plain", 1000)]), true);
    assert.deepEqual(plain, []);
    assert.equal(status.cardDetail(at("plain", [waiting("plain", 1000)])), "tell me which one you meant.");
  });
});

describe("a turn that ended on Nothing for you", () => {
  it("asks nothing when saved as idle, or in the older wordings, but not for nothing follows", () => {
    assert.equal(move.asksNothing({ text: "CI is running.", idle: true }), true);
    assert.equal(move.asksNothing({ text: "nothing. Waiting until CI lands." }), true);
    assert.equal(move.asksNothing({ text: "Nothing: the pass is running." }), true);
    assert.equal(move.asksNothing({ text: "PR #130 is merged; nothing waits on you." }), true);
    assert.equal(move.asksNothing({ text: "the work is finished and nothing follows. /clear now." }), false);
    assert.equal(move.asksNothing({ text: "Nothing follows: /clear now." }), false);
    assert.equal(move.asksNothing({ text: "say go." }), false);
  });

  it("reads as idle once the nudge lands, since the turn ended, and leaves Needs you", () => {
    const w = at("quiet", [waiting("quiet", 1060)]);
    r.data.workspaces = [w];
    const a = status.agentOf(w);
    assert.equal(a?.status, "idle");
    assert.equal(a?.sinceEpoch, 1000, "idle since the turn ended, not since the nudge");
    assert.equal(cockpit.needsList().length, 0);
    assert.equal(status.cardDetail(w), "CI is running on #2171. I report when it lands.");
    assert.deepEqual(cockpit.chipsFor(w, true), [], "no size chip");
  });

  it("reads the older Your move: nothing line the same way", () => {
    assert.equal(status.agentOf(at("legacy", [waiting("legacy", 1060)]))?.status, "idle");
  });

  it("still needs Jon on a Your move line, a new prompt since, or a real ask", () => {
    assert.equal(status.agentOf(at("quick", [waiting("quick", 1060)]))?.status, "needs_input");
    assert.equal(status.agentOf(at("quiet", [waiting("quiet", 1160)], { latestAt: 1100 }))?.status, "needs_input");
    const asks = waiting("quietAsks", 1060);
    assert.equal(needs.effectiveAgent(asks, at("quietAsks", [asks])).status, "needs_input");
  });

  it("leaves another session's agent alone", () => {
    const other = agent("needs_input", { id: "s-other", kind: "claude", sinceEpoch: 1060, lastActivityAt: 1060 });
    assert.equal(status.agentOf(at("quiet", [other]))?.status, "needs_input");
  });
});
