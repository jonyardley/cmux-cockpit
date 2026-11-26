// The agents panel reads each agent's status and why it waits on Jon from
// the core's saved `agents` map (#429), laid on cmux's agents by id: a
// turn, an ask with or without its words, and the Cockpit's own waits (a
// stop, CI, a park, a stand-in), with cmux's plain status where nothing is
// saved. __STATE__ is set before the renderer import, as the modules read it
// at import.

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
  moves: {},
  agents: {
    turn: [{ id: "t", status: "needs_input", since: 1000, why: "turn" }],
    asks: [{ id: "k", status: "needs_input", since: 1000.123, why: "ask", reason: "allow git push?" }],
    bare: [{ id: "b", status: "needs_input", since: 1000, why: "ask" }],
    stop: [{ id: "s", status: "needs_input", since: 1000, why: "stop" }],
    ci: [{ id: "c", status: "needs_input", since: 900, why: "ci" }],
    park: [{ id: "p", status: "needs_input", since: 900, why: "park" }],
    stand: [{ id: "stand-in", status: "needs_input", since: 900, why: "park" }],
    undated: [{ id: "u", status: "needs_input", since: 0, why: "turn" }],
    busy: [{ id: "w", status: "working", since: 1000 }],
    sel: [{ id: "k", status: "needs_input", since: 1000.123, why: "ask", reason: "allow git push?" }],
    done: [{ id: "d", status: "needs_input", since: 1100, why: "turn" }],
  },
  ui: {},
};

const { installRenderer } = await import("./support/renderer.ts");
const r = installRenderer();
const { agent, ws } = await import("./support/fixtures.ts");
const needs = await import("../src/shared/needs.ts");
const m = await import("../src/agents/model.ts");
const { T } = await import("../src/agents/theme.ts");

const idle = (id: string, since = 1000) => agent("idle", { id, sinceEpoch: since, lastActivityAt: since });
const asking = (id: string, since = 1000.1234) =>
  agent("needs_input", { id, sinceEpoch: since, lastActivityAt: since });
const working = (id: string, since: number) => agent("working", { id, sinceEpoch: since, lastActivityAt: since });
const one = (w: Workspace): Agent | undefined => needs.agentsOf(w)[0];

beforeEach(() => {
  r.data.epoch = 1060;
  r.data.workspaces = [];
  r.opened.length = 0;
});

describe("agentsOf with the Cockpit's saved agents", () => {
  it("reads a saved turn as needs_input from the turn end, never an ask", () => {
    const w = ws("turn", { agents: [idle("t", 1002)] });
    assert.equal(one(w)?.status, "needs_input");
    assert.equal(one(w)?.sinceEpoch, 1000);
    assert.equal(needs.waitWhy(one(w), w), "turn");
    assert.equal(needs.askReason(one(w), w), null);
  });

  it("reads a saved ask with its words, and one with none as a plain needs_input", () => {
    const w = ws("asks", { agents: [asking("k")] });
    assert.equal(needs.askReason(one(w), w), "allow git push?");
    const bare = ws("bare", { agents: [asking("b")] });
    assert.equal(one(bare)?.status, "needs_input");
    assert.equal(needs.askReason(one(bare), bare), null);
  });

  it("leaves the Cockpit's waits off the status, and names them by why", () => {
    const stop = ws("stop", { agents: [working("s", 900)] });
    assert.equal(one(stop)?.status, "working", "the stop shows in the ask block, not the row");
    assert.equal(needs.cockpitWait(one(stop), stop), "stop");
    const ci = ws("ci", { agents: [idle("c")] });
    assert.equal(one(ci)?.status, "idle");
    assert.equal(needs.cockpitWait(one(ci), ci), "ci");
    assert.equal(needs.waitWhy(one(ci), ci), undefined, "a carrier's own status is not waiting");
    const park = ws("park", { agents: [working("p", 1000)] });
    assert.equal(needs.cockpitWait(one(park), park), "park", "a park holds on a lead that works on");
    assert.equal(needs.cockpitWait(undefined, park), undefined);
  });

  it("stands the core's stand-in in only for a workspace with no agent", () => {
    assert.equal(needs.standInWhy(ws("stand", { agents: [] })), "park");
    assert.equal(needs.standInWhy(ws("stand", { agents: [idle("x")] })), undefined);
    assert.equal(needs.standInWhy(ws("turn")), undefined);
    assert.equal(needs.standInWhy(undefined), undefined);
  });

  it("drops an entry its agent has worked past, so a new prompt shows at once", () => {
    const w = ws("turn", { agents: [working("t", 1010)] });
    assert.equal(one(w)?.status, "working");
    assert.equal(needs.waitWhy(one(w), w), undefined);
    const back = ws("asks", { agents: [working("k", 1010)] });
    assert.equal(needs.askReason(one(back), back), null);
  });

  it("drops a saved working once cmux says the agent stopped", () => {
    assert.equal(one(ws("busy", { agents: [idle("w", 1100)] }))?.status, "idle");
    assert.equal(one(ws("busy", { agents: [working("w", 1000)] }))?.status, "working");
  });

  it("shows cmux's plain status with no entry, as with the Cockpit closed", () => {
    const plain = idle("other");
    assert.deepEqual(needs.agentsOf(ws("turn", { agents: [plain] })), [plain]);
    assert.deepEqual(needs.agentsOf(ws("nothing", { agents: [plain] })), [plain]);
    assert.deepEqual(needs.agentsOf(undefined), []);
  });

  it("keeps cmux's own start when the core saved none", () => {
    assert.equal(one(ws("undated", { agents: [idle("u", 1003)] }))?.sinceEpoch, 1003);
  });

  it("leaves out an agent cmux sends with no status (issue #7)", () => {
    assert.deepEqual(needs.agentsOf(ws("turn", { agents: [{ id: "t" }] })), []);
  });
});

describe("dismissing over a saved entry", () => {
  it("reads idle at once, keyed on cmux's own start, and holds past the clock while the entry lags", () => {
    const a = asking("k");
    const w = ws("asks", { agents: [a] });
    needs.dismissNeeds(w);
    assert.equal(one(w)?.status, "idle");
    assert.equal(needs.askReason(one(w), w), null, "a dismissal is never an ask");
    assert.deepEqual(r.opened, [
      `cmux-cockpit://set?key=dismissed.asks&value=${encodeURIComponent(JSON.stringify({ k: 1000.1234 }))}`,
    ]);
    r.data.epoch = 1060 + 3600;
    assert.equal(one(w)?.status, "idle", "the saved entry still says needs_input");
    w.agents = [asking("k", 2000)];
    assert.equal(one(w)?.status, "needs_input", "a new ask shows again");
  });

  it("leaves the Cockpit's waits to the Cockpit", () => {
    needs.dismissNeeds(ws("stop", { agents: [working("s", 900)] }));
    needs.dismissNeeds(ws("ci", { agents: [idle("c")] }));
    assert.deepEqual(r.opened, []);
  });
});

describe("the agents panel", () => {
  it("heads an asking workspace amber, with its reason over the buttons", () => {
    r.data.epoch = 1070;
    const asker = asking("k");
    r.data.workspaces = [ws("sel", { selected: true, agents: [asker], latestMessage: "I will push now." })];
    const shown = m.cur().a;
    assert.equal(m.headStatus(shown), "Asking 1m");
    assert.equal(m.statusLine(shown), "asking 1m");
    assert.equal(m.dotFor(shown), T.amber);
    assert.equal(m.haloFor(shown), T.amberHalo);
    assert.equal(m.statusColor(shown), T.amberText);
    assert.equal(m.currentAsk()?.text, "allow git push?");
  });

  it("keeps a finished turn clay and says it is your turn", () => {
    r.data.epoch = 1110;
    r.data.workspaces = [ws("done", { selected: true, agents: [idle("d", 1100)], latestMessage: "All green." })];
    const shown = m.cur().a;
    assert.equal(m.headStatus(shown), "Your turn <1m");
    assert.equal(m.dotFor(shown), T.clay);
    assert.equal(m.haloFor(shown), T.clayHalo);
    assert.equal(m.statusColor(shown), T.clayText);
    assert.equal(m.currentAsk()?.text, "All green.");
  });

  it("colours agents that are not asking by their status, and no agent grey", () => {
    r.data.workspaces = [ws("sel", { selected: true, agents: [agent("working")] })];
    assert.equal(m.dotFor(agent("working")), T.blue);
    assert.equal(m.statusColor(agent("idle")), T.metaText);
    assert.equal(m.dotFor(null), T.grey);
    assert.equal(m.statusColor(null), T.secondary);
    assert.equal(m.haloFor(null), "clear");
  });
});
