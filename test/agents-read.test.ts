// The agents panel reads each agent's status and why it waits on Jon from
// the core's saved `agents` map (#429), laid on cmux's agents by id: a
// turn, an ask with or without its words, and the Cockpit's own waits (a
// stop, CI, a park, a stand-in), with cmux's plain status where nothing is
// saved. __STATE__ is set before the renderer import, as the modules read it
// at import.

import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

(globalThis as Record<string, unknown>).__STATE__ = {
  dismissed: { pair: { a: 1000 } },
  projectOverride: {},
  projects: {},
  prs: {},
  ownPrs: {},
  subagents: {},
  published: {},
  prOrigins: {},
  moves: {
    mv: { text: "pick one", epoch: 1000, session: "t", decisions: 2, leans: "1b 2a" },
    mvOld: { text: "pick one", epoch: 900, session: "t" },
    mvOther: { text: "pick one", epoch: 1000, session: "x" },
  },
  agents: {
    staleIdle: [{ id: "a", status: "idle", since: 1000.124 }],
    oldAsk: [{ id: "k", status: "needs_input", since: 1000, why: "ask", reason: "allow git push?" }],
    pair: [
      { id: "a", status: "idle", since: 1000 },
      { id: "b", status: "needs_input", since: 1010, why: "ask" },
    ],
    mv: [{ id: "t", status: "needs_input", since: 1000, why: "turn" }],
    mvOld: [{ id: "t", status: "needs_input", since: 1000, why: "turn" }],
    mvOther: [{ id: "t", status: "needs_input", since: 1000, why: "turn" }],
    lag: [{ id: "s", status: "needs_input", since: 1000, why: "stop" }],
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
const details = await import("../src/agents/details.ts");
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

  it("shows a permission prompt that came after a saved idle, and holds a dismissed ask's idle", () => {
    const later = ws("staleIdle", { agents: [asking("a", 1040)] });
    assert.equal(one(later)?.status, "needs_input");
    assert.equal(one(later)?.sinceEpoch, 1040);
    const same = ws("staleIdle", { agents: [asking("a", 1000.1234)] });
    assert.equal(one(same)?.status, "idle", "saved at the ask's start, to the millisecond");
  });

  it("drops a saved ask's words once a later needs_input comes", () => {
    const w = ws("oldAsk", { agents: [asking("k", 1040)] });
    assert.equal(one(w)?.status, "needs_input");
    assert.equal(one(w)?.sinceEpoch, 1040);
    assert.equal(needs.askReason(one(w), w), null);
  });

  it("drops a saved turn once a prompt comes after it, and keeps it through a later start alone", () => {
    const idleAfter = ws("turn", { latestAt: 1020, agents: [idle("t", 1030)] });
    assert.equal(one(idleAfter)?.status, "idle");
    assert.equal(needs.waitWhy(one(idleAfter), idleAfter), undefined);
    const askAfter = ws("turn", { latestAt: 1020, agents: [asking("t", 1040)] });
    assert.equal(one(askAfter)?.sinceEpoch, 1040, "a later spell keeps its own age");
    assert.equal(needs.waitWhy(one(askAfter), askAfter), undefined);
    const slack = ws("turn", { latestAt: 1002, agents: [idle("t", 1060)] });
    assert.equal(needs.waitWhy(one(slack), slack), "turn", "a prompt within the slack is the turn's own");
    assert.equal(one(slack)?.sinceEpoch, 1000);
  });

  it("never keeps a saved turn on a working agent, even with no start", () => {
    const w = ws("turn", { agents: [agent("working", { id: "t" })] });
    assert.equal(one(w)?.status, "working");
    assert.equal(needs.waitWhy(one(w), w), undefined);
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

  it("keeps an earlier dismissal the core has since saved as idle when another is dismissed", () => {
    const w = ws("pair", { agents: [idle("a", 1000), asking("b", 1010)] });
    assert.deepEqual(
      needs.agentsOf(w).map((a) => a.status),
      ["idle", "needs_input"],
    );
    needs.dismissNeeds(w);
    assert.deepEqual(r.opened, [
      `cmux-cockpit://set?key=dismissed.pair&value=${encodeURIComponent(JSON.stringify({ a: 1000, b: 1010 }))}`,
    ]);
  });

  it("keys an undated saved turn on cmux's start, so the dismissal is saved", () => {
    const w = ws("undated", { agents: [idle("u", 1003)] });
    needs.dismissNeeds(w);
    assert.equal(one(w)?.status, "idle");
    assert.deepEqual(r.opened, [
      `cmux-cockpit://set?key=dismissed.undated&value=${encodeURIComponent(JSON.stringify({ u: 1003 }))}`,
    ]);
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

describe("the move and the Cockpit's waits on the selected workspace", () => {
  it("shows the move only for the agent's own saved turn, ending on it", () => {
    r.data.workspaces = [ws("mv", { selected: true, agents: [idle("t", 1000)] })];
    assert.deepEqual(details.moveDetail(), { text: "pick one", meta: "2 decisions open, leaning 1b 2a" });
    r.data.workspaces = [ws("mvOld", { selected: true, agents: [idle("t", 1000)] })];
    assert.equal(details.moveDetail(), null, "a move from an earlier turn");
    r.data.workspaces = [ws("mvOther", { selected: true, agents: [idle("t", 1000)] })];
    assert.equal(details.moveDetail(), null, "another session's move");
  });

  it("counts no carrier whose wait the waits map does not hold yet", () => {
    r.data.workspaces = [ws("lag", { selected: true, agents: [idle("s", 1000)], latestMessage: "Done." })];
    assert.equal(needs.cockpitWait(m.cur().a, m.cur().ws), "stop");
    assert.equal(m.currentAsk(), null);
  });
});
