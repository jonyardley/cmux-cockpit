// A chat's saved "Your move" line: shown while its turn end is still waiting
// and no prompt has come since it was saved (cmux's latestAt), only on the
// Claude session that saved it, never while the chat works or asks.
// __STATE__ is set before the renderer import, as in asking-saved.test.ts.

import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import type { SavedMove } from "../scripts/state-config.ts";

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
    quietDecide: { text: "CI is running.", epoch: 1000, session: "s-quietDecide", idle: true, decisions: 2 },
    quoted: { text: "Reply with the letter.", epoch: 1000, session: "s-quoted", unlabelled: true },
  },
  ui: {},
};

const { installRenderer } = await import("./support/renderer.ts");
const r = installRenderer();
const { agent, ws } = await import("./support/fixtures.ts");
const move = await import("../src/shared/move.ts");
const needs = await import("../src/shared/needs.ts");
const { moveDescription } = await import("../scripts/state-config.ts");

// The agent a single-agent workspace shows, and the move it is waiting on.
const shown = (w: Workspace): Agent | null => needs.agentsOf(w)[0] ?? null;
const moveOf = (w: Workspace): SavedMove | null => {
  const a = shown(w);
  return move.waitingMove(a, w, needs.askReason(a, w) !== null);
};

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

describe("moveOf", () => {
  it("shows at idle straight after Stop, when the move is newer than the last prompt", () => {
    const w = at("quick", [stopped("quick", 1000)]);
    assert.equal(shown(w)?.status, "idle");
    assert.equal(moveOf(w)?.text, "the work is finished. Run /clear now.");
    assert.ok(
      moveOf(at("quick", [stopped("quick", 1000)], { latestAt: 1000 + 3 })),
      "Stop in iMessage mode, slack aside",
    );
  });

  it("shows none when no prompt is known, since the move's age cannot be told", () => {
    assert.equal(moveOf(ws("quick", { agents: [stopped("quick", 1000)] })), null, "no latestAt");
    assert.equal(moveOf(ws("quick", { agents: [stopped("quick", 1000)], latestAt: 0 })), null, "latestAt 0");
  });

  it("still shows after the nudge restamps the spell and the activity a minute on", () => {
    // idle_prompt about 60s after Stop: needs_input, sinceEpoch and lastActivityAt at its arrival, latestAt untouched.
    const w = at("quick", [waiting("quick", 1060)]);
    assert.equal(shown(w)?.status, "needs_input");
    assert.equal(moveOf(w)?.text, "the work is finished. Run /clear now.");
  });

  it("is gone once a prompt comes after it: a new turn, or an interrupted one", () => {
    // A new prompt at 1100 while the agent still reads as at its turn end: the move from 1000 is the turn before's.
    assert.equal(moveOf(at("quick", [stopped("quick", 1000)], { latestAt: 1100 })), null);
    // Interrupted at 1150 with no Stop, so nothing saved a new move: still gone.
    assert.equal(moveOf(at("quick", [stopped("quick", 1150)], { latestAt: 1100 })), null);
    assert.equal(moveOf(at("quick", [waiting("quick", 1210)], { latestAt: 1100 })), null, "nudged after the interrupt");
    assert.equal(moveOf(at("quick", [stopped("quick", 1000)], { latestAt: 1000 + 4 })), null, "past the slack");
  });

  it("is null while it works, while it asks, once it ended, or without a saved move", () => {
    assert.equal(moveOf(at("quick", [agent("working", { ...own("quick"), sinceEpoch: 1000 })])), null);
    assert.equal(moveOf(at("asks", [waiting("asks", 1000)])), null);
    assert.equal(moveOf(at("quick", [agent("ended", { ...own("quick"), sinceEpoch: 1010 })])), null);
    assert.equal(moveOf(at("none", [stopped("none", 1000)])), null);
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

describe("a turn that ended on Nothing for you", () => {
  it("asks nothing when saved as idle, or in the older wordings, but not for nothing follows", () => {
    assert.equal(move.asksNothing({ text: "CI is running.", idle: true }), true);
    assert.equal(move.asksNothing({ text: "nothing. Waiting until CI lands." }), true);
    assert.equal(move.asksNothing({ text: "Nothing: the pass is running." }), true);
    assert.equal(move.asksNothing({ text: "PR #130 is merged; nothing waits on you." }), true);
    assert.equal(move.asksNothing({ text: "the work is finished and nothing follows. /clear now." }), false);
    assert.equal(move.asksNothing({ text: "Nothing follows: /clear now." }), false);
    assert.equal(move.asksNothing({ text: "nothing pending. /clear now." }), false);
    assert.equal(move.asksNothing({ text: "nothing to decide, say go." }), false);
    assert.equal(move.asksNothing({ text: "CI is running.", idle: true, decisions: 1 }), false, "decisions still wait");
    assert.equal(move.asksNothing({ text: "say go." }), false);
  });

  it("reads as idle once the nudge lands, since the turn ended, and leaves Needs you", () => {
    const w = at("quiet", [waiting("quiet", 1060)]);
    r.data.workspaces = [w];
    const a = shown(w);
    assert.equal(a?.status, "idle");
    assert.equal(a?.sinceEpoch, 1000, "idle since the turn ended, not since the nudge");
  });

  it("reads the older Your move: nothing line the same way", () => {
    assert.equal(shown(at("legacy", [waiting("legacy", 1060)]))?.status, "idle");
  });

  it("still needs Jon on a Your move line, a new prompt since, or a real ask", () => {
    assert.equal(shown(at("quick", [waiting("quick", 1060)]))?.status, "needs_input");
    assert.equal(shown(at("quiet", [waiting("quiet", 1160)], { latestAt: 1100 }))?.status, "needs_input");
    const asks = waiting("quietAsks", 1060);
    assert.equal(needs.effectiveAgent(asks, at("quietAsks", [asks])).status, "needs_input");
  });

  it("still needs Jon on a later stop with no prompt between, or with decisions laid out", () => {
    // The agent woke on its own after CI and stopped to ask, well past the nudge.
    assert.equal(shown(at("quiet", [waiting("quiet", 1000 + move.NUDGE_WINDOW + 1)]))?.status, "needs_input");
    assert.equal(shown(at("quietDecide", [waiting("quietDecide", 1060)]))?.status, "needs_input");
  });

  it("leaves another session's agent alone", () => {
    const other = agent("needs_input", { id: "s-other", kind: "claude", sinceEpoch: 1060, lastActivityAt: 1060 });
    assert.equal(shown(at("quiet", [other]))?.status, "needs_input");
  });
});

describe("a move in the workspace description", () => {
  const described = (
    id: string,
    m: { text: string; epoch: number; decisions?: number },
    extra: Partial<Workspace> = {},
  ) => at(id, [stopped(id, m.epoch)], { description: moveDescription({ ...m, session: "s-" + id }), ...extra });

  it("shows with no saved move and no rebuild, decisions and all", () => {
    const w = described("live", { text: 'reply "1a".', epoch: 1000, decisions: 1 });
    assert.equal(moveOf(w)?.text, 'reply "1a".');
    assert.equal(moveOf(w)?.decisions, 1);
  });

  it("loses to a newer saved move, and wins over an older one", () => {
    assert.equal(
      moveOf(described("quick", { text: "older", epoch: 990 }))?.text,
      "the work is finished. Run /clear now.",
    );
    assert.equal(moveOf(described("quick", { text: "newer", epoch: 1010 }))?.text, "newer");
  });

  it("never shows its raw form once a prompt has retired it", () => {
    const w = described("live", { text: "say go", epoch: 1000 }, { latestAt: 1100, latestMessage: "" });
    assert.equal(moveOf(w), null);
  });
});
