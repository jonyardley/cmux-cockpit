// Jon's 13 November report: a chat ended its turn on "Your move: answer yes
// or no once the left panel redraws." while a shell it started earlier
// still ran. The Cockpit card says Your turn (#374); the agents panel's
// This workspace card said "Running 3m · 1 shell". The panel applies the
// core's saved Running verdict only while the agent it shows is idle
// (shared/running.ts), so the agent as the panel shows it (agentsOf) must
// read needs_input from the turn end, as the core saved it (#429). Only a
// turn the core saved as idle ("Nothing for you"), or a dismissed wait,
// still says Running. __STATE__ is set before the renderer import, as in
// agents-read.test.ts.

import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

const NOW = 1_000_000;
// The turn ended a minute ago; the shell started four minutes ago.
const END = NOW - 60;
const SHELL = { since: NOW - 240, counts: [{ type: "shell", n: 1 }] };
const IDS = ["turn", "nudged", "quiet", "closed", "dismiss", "reloaded"];
// The core's save for a turn that waits on Jon, and for one that asks nothing.
const turn = (id: string) => [{ id: "c-" + id, status: "needs_input", since: END, why: "turn" }];
const idle = (id: string) => [{ id: "c-" + id, status: "idle", since: END }];

(globalThis as Record<string, unknown>).__STATE__ = {
  dismissed: { reloaded: { "c-reloaded": END } },
  projectOverride: {},
  projects: {},
  prs: {},
  ownPrs: {},
  subagents: {},
  published: {},
  prOrigins: {},
  moves: {},
  running: Object.fromEntries(IDS.map((id) => [id, { agent: "c-" + id, ...SHELL }])),
  agents: {
    turn: turn("turn"),
    nudged: turn("nudged"),
    quiet: idle("quiet"),
    dismiss: turn("dismiss"),
    reloaded: turn("reloaded"),
  },
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
// A needs_input about a minute on with no prompt between, both stamps at its arrival.
const nudged = (id: string, at = NOW): Agent =>
  agent("needs_input", { id: "c-" + id, kind: "claude", sinceEpoch: at, lastActivityAt: at });
// The selected workspace, its last prompt before the turn ended.
const selected = (id: string, a: Agent): Workspace => {
  const w = ws(id, { selected: true, latestAt: END - 300, agents: [a] });
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
    assert.equal(needs.askReason(model.cur().a, model.cur().ws), null, "a turn is never an ask");
  });

  it("says the same, from the turn end, once a needs_input lands a minute on", () => {
    selected("nudged", nudged("nudged"));
    assert.deepEqual(head(), YOUR_TURN);
  });

  it("says Running on a turn the Cockpit saved as asking nothing, or with no Cockpit", () => {
    selected("quiet", stopped("quiet"));
    assert.deepEqual(head(), RUNNING);
    selected("closed", stopped("closed"));
    assert.deepEqual(head(), RUNNING);
  });
});

describe("dismissing that wait", () => {
  it("says Running at once, and stays dismissed across reads, a later needs_input and the clock", () => {
    const w = selected("dismiss", stopped("dismiss"));
    needs.dismissNeeds(w);
    assert.deepEqual(head(), RUNNING);
    assert.deepEqual(head(), RUNNING, "a second read does not prune it");
    selected("dismiss", nudged("dismiss"));
    assert.deepEqual(head(), RUNNING, "keyed on the turn end, so the restamp keeps it");
    r.data.epoch = NOW + 3600;
    assert.equal(model.cur().a?.status, "idle", "the saved entry still says needs_input an hour on");
    const saved = r.opened.find((u) => u.includes("dismissed.dismiss"));
    assert.ok(saved?.includes(encodeURIComponent(JSON.stringify({ "c-dismiss": END }))), "saved at the turn end");
  });

  it("holds over a saved entry the core has not yet rewritten, after a reload", () => {
    selected("reloaded", nudged("reloaded"));
    assert.deepEqual(head(), RUNNING);
  });
});
