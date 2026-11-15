// Jon's 13 November report: a chat ended its turn on "Your move: answer yes
// or no once the left panel redraws." while a shell it started earlier
// still ran. The Cockpit card says Your turn (#374, waiting_turn and
// effective_agent in native/core/src/needs.rs); the agents panel's This
// workspace card said "Running 3m · 1 shell". The panel applies the
// core's saved Running verdict only while the agent it shows is idle
// (shared/running.ts), so the agent as the panel shows it (agentsOf) must
// read needs_input from the turn end, as the core's does. Only a "Nothing
// for you" turn, or a dismissed wait, still says Running.
// __STATE__ is set before the renderer import, as in move-saved.test.ts.

import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

const NOW = 1_000_000;
// The turn ended a minute ago; the shell started four minutes ago.
const END = NOW - 60;
const SHELL = { since: NOW - 240, counts: [{ type: "shell", n: 1 }] };
const running = (agent: string) => ({ agent, ...SHELL });

(globalThis as Record<string, unknown>).__STATE__ = {
  dismissed: {},
  projectOverride: {},
  projects: {},
  prs: {},
  ownPrs: {},
  subagents: {},
  published: {},
  prOrigins: {},
  asking: { answered: { reason: "allow git push?", epoch: END - 2, session: "c-answered" } },
  moves: {
    turn: { text: "answer yes or no once the left panel redraws.", epoch: END, session: "c-turn" },
    nudged: { text: "answer yes or no once the left panel redraws.", epoch: END, session: "c-nudged" },
    bare: { text: "Shall I go on?", epoch: END, session: "c-bare", unlabelled: true },
    quiet: { text: "the dev server runs on.", epoch: END, session: "c-quiet", idle: true },
    gone: { text: "answer yes or no once the left panel redraws.", epoch: END, session: "c-gone" },
    other: { text: "answer yes or no once the left panel redraws.", epoch: END, session: "c-someone" },
    answered: { text: "go", epoch: END, session: "c-answered" },
    dismiss: { text: "go", epoch: END, session: "c-dismiss" },
  },
  running: Object.fromEntries(
    ["turn", "nudged", "bare", "quiet", "gone", "other", "answered", "dismiss"].map((id) => [id, running("c-" + id)]),
  ),
  ui: {},
};

const { installRenderer } = await import("./support/renderer.ts");
const r = installRenderer();
const { agent, ws } = await import("./support/fixtures.ts");
const model = await import("../src/agents/model.ts");
const needs = await import("../src/shared/needs.ts");
const { T } = await import("../src/agents/theme.ts");

// Claude's Stop leaves the agent idle, stamped at the turn end.
const stopped = (id: string): Agent =>
  agent("idle", { id: "c-" + id, kind: "claude", sinceEpoch: END, lastActivityAt: END });
// The idle nudge about a minute on: needs_input, both stamps at its arrival.
const nudged = (id: string, at = NOW): Agent =>
  agent("needs_input", { id: "c-" + id, kind: "claude", sinceEpoch: at, lastActivityAt: at });
// The selected workspace, its last prompt before the turn ended.
const selected = (id: string, a: Agent, extra: Partial<Workspace> = {}): Workspace => {
  const w = ws(id, { selected: true, latestAt: END - 300, agents: [a], ...extra });
  r.data.workspaces = [w];
  return w;
};

// The This workspace card's head, as current.ts draws it from model.current().
function head(): { status: string; dot: string; halo: string; ink: string; asks: boolean } {
  const c = model.cur();
  return {
    status: model.headStatus(c.a, c.ws),
    dot: model.dotFor(c.a, c.ws),
    halo: model.haloFor(c.a, c.ws),
    ink: model.statusColor(c.a, c.ws),
    asks: model.currentAsk() !== null,
  };
}

const YOUR_TURN = { status: "Your turn 1m", dot: T.clay, halo: T.clayHalo, ink: T.clayText, asks: true };
const RUNNING = { status: "Running 4m · 1 shell", dot: T.blue, halo: T.blueHalo, ink: T.blueText, asks: false };

beforeEach(() => {
  r.data.epoch = NOW;
});

describe("a turn that asks Jon something while its chat's work runs", () => {
  it("says Your turn from the turn end, not Running from the shell's start", () => {
    selected("turn", stopped("turn"));
    assert.deepEqual(head(), YOUR_TURN);
  });

  it("says the same once the idle nudge lands a minute on", () => {
    selected("nudged", nudged("nudged"));
    assert.deepEqual(head(), YOUR_TURN);
  });

  it("counts a reply with no label, which still waits on Jon (#322)", () => {
    selected("bare", stopped("bare"));
    assert.deepEqual(head(), YOUR_TURN);
  });

  it("says Running on a Nothing for you turn, stopped or nudged", () => {
    selected("quiet", stopped("quiet"));
    assert.deepEqual(head(), RUNNING);
    selected("quiet", nudged("quiet"));
    assert.deepEqual(head(), RUNNING);
  });

  it("says Running once a prompt retires the move, or when the move is another session's", () => {
    selected("gone", stopped("gone"), { latestAt: END + 10 });
    assert.deepEqual(head(), RUNNING);
    selected("other", stopped("other"));
    assert.deepEqual(head(), RUNNING);
  });

  it("is Your turn, not Asking, when an ask was answered just before the turn ended", () => {
    selected("answered", stopped("answered"));
    assert.deepEqual(head(), YOUR_TURN);
    assert.equal(needs.askReason(model.cur().a, model.cur().ws), null);
  });
});

describe("dismissing that wait", () => {
  it("says Running, and stays dismissed across reads and after the nudge lands", () => {
    const w = selected("dismiss", stopped("dismiss"));
    needs.dismissNeeds(w);
    assert.deepEqual(head(), RUNNING);
    assert.deepEqual(head(), RUNNING, "a second read does not prune it");
    selected("dismiss", nudged("dismiss"));
    assert.deepEqual(head(), RUNNING, "keyed on the turn end, so the nudge keeps it");
    const saved = r.opened.find((u) => u.includes("dismissed.dismiss"));
    assert.ok(saved?.includes(encodeURIComponent(JSON.stringify({ "c-dismiss": END }))), "saved at the turn end");
  });
});
