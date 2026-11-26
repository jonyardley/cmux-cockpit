// The agents panel reads each agent's status and why it waits on Jon from
// the core's saved `agents` map (#429), laid on cmux's agents by id: a
// turn, an ask with or without its words, and the Cockpit's own waits (a
// stop, CI, a park, a stand-in), with cmux's plain status where nothing is
// saved. An entry holds only while cmux shows the status the core saw, from
// a start within 3 seconds of the core's (`seen`). __STATE__ is set before
// the renderer import, as the modules read it at import.

import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

const seen = (status: string, since: number) => ({ status, since });

(globalThis as Record<string, unknown>).__STATE__ = {
  dismissed: {
    pair: { a: 1000 },
    wbGone: { g: 900, b: 1010 },
    wbAsk: { a: 1000.1234, c: 900 },
    wbTurn: { t: 1000, o: 500, ci: 800 },
  },
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
  waits: {
    stop: [{ kind: "stopped", since: 1000, key: 1000, agent: "s", detail: "error" }],
    ci: [{ kind: "ci_failing", since: 900, key: 900, detail: "Tabs" }],
    park: [{ kind: "park", since: 900, key: 900, detail: "notes-app#42 needs a decision" }],
    stopDrift: [{ kind: "stopped", since: 1000, key: 1000, agent: "s", detail: "error" }],
    parkDrift: [{ kind: "park", since: 900, key: 900, detail: "notes-app#42 needs a decision" }],
  },
  agents: {
    staleIdle: [{ id: "a", status: "idle", since: 1000.124, seen: seen("needs_input", 1000.124) }],
    oldAsk: [
      {
        id: "k",
        status: "needs_input",
        since: 1000,
        why: "ask",
        reason: "allow git push?",
        seen: seen("needs_input", 1000),
      },
    ],
    pair: [
      { id: "a", status: "idle", since: 1000, seen: seen("needs_input", 1000) },
      { id: "b", status: "needs_input", since: 1010, why: "ask", seen: seen("needs_input", 1010) },
    ],
    wbAsk: [
      { id: "a", status: "idle", since: 1000.124, seen: seen("needs_input", 1000.124) },
      { id: "b", status: "needs_input", since: 1010, why: "ask", seen: seen("needs_input", 1010) },
      { id: "c", status: "idle", since: 1100, seen: seen("idle", 1100) },
    ],
    wbTurn: [
      { id: "t", status: "idle", since: 1001.5, seen: seen("idle", 1001.5) },
      { id: "o", status: "idle", since: 500, seen: seen("idle", 500) },
      { id: "b", status: "needs_input", since: 1010, why: "ask", seen: seen("needs_input", 1010) },
    ],
    mv: [{ id: "t", status: "needs_input", since: 1000, why: "turn", seen: seen("idle", 1000) }],
    mvOld: [{ id: "t", status: "needs_input", since: 1000, why: "turn", seen: seen("idle", 1000) }],
    mvOther: [{ id: "t", status: "needs_input", since: 1000, why: "turn", seen: seen("idle", 1000) }],
    lag: [{ id: "s", status: "needs_input", since: 1000, why: "stop", seen: seen("needs_input", 1000) }],
    turn: [{ id: "t", status: "needs_input", since: 1000, why: "turn", seen: seen("idle", 1000) }],
    asks: [
      {
        id: "k",
        status: "needs_input",
        since: 1000.124,
        why: "ask",
        reason: "allow git push?",
        seen: seen("needs_input", 1000.124),
      },
    ],
    bare: [{ id: "b", status: "needs_input", since: 1000.124, why: "ask", seen: seen("needs_input", 1000.124) }],
    stop: [{ id: "s", status: "needs_input", since: 1000, why: "stop", seen: seen("working", 900) }],
    ci: [{ id: "c", status: "needs_input", since: 900, why: "ci", seen: seen("idle", 1000) }],
    park: [{ id: "p", status: "needs_input", since: 900, why: "park", seen: seen("working", 1000) }],
    stand: [{ id: "stand-in", status: "needs_input", since: 900, why: "park" }],
    undated: [{ id: "u", status: "needs_input", since: 0, why: "turn", seen: seen("idle", 1003) }],
    nostart: [{ id: "n", status: "needs_input", since: 0, why: "turn", seen: seen("idle", 0) }],
    busy: [{ id: "w", status: "working", since: 1000, seen: seen("working", 1000) }],
    stopDrift: [{ id: "s", status: "needs_input", since: 1000, why: "stop", seen: seen("working", 900) }],
    parkDrift: [{ id: "p", status: "needs_input", since: 900, why: "park", seen: seen("working", 1000) }],
    wbGone: [{ id: "b", status: "needs_input", since: 1010, why: "ask", seen: seen("needs_input", 1010) }],
    unseen: [{ id: "t", status: "needs_input", since: 1000, why: "turn" }],
    sel: [
      {
        id: "k",
        status: "needs_input",
        since: 1000.124,
        why: "ask",
        reason: "allow git push?",
        seen: seen("needs_input", 1000.124),
      },
    ],
    done: [{ id: "d", status: "needs_input", since: 1100, why: "turn", seen: seen("idle", 1100) }],
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
const setUrl = (wsId: string, value: unknown): string =>
  `cmux-cockpit://set?key=dismissed.${wsId}&value=${encodeURIComponent(JSON.stringify(value))}`;

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
    assert.equal(needs.turnStart(one(w), w), 1000);
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
    assert.equal(needs.turnStart(one(ci), ci), undefined, "a carrier's own status is not waiting");
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
    assert.equal(needs.turnStart(one(w), w), undefined);
    const back = ws("asks", { agents: [working("k", 1010)] });
    assert.equal(needs.askReason(one(back), back), null);
  });

  it("drops a saved working once cmux says the agent stopped", () => {
    assert.equal(one(ws("busy", { agents: [idle("w", 1100)] }))?.status, "idle");
    assert.equal(one(ws("busy", { agents: [working("w", 1001)] }))?.sinceEpoch, 1001, "cmux's own start");
  });

  it("shows cmux's plain status with no entry, as with the Cockpit closed", () => {
    const plain = idle("other");
    assert.deepEqual(needs.agentsOf(ws("turn", { agents: [plain] })), [plain]);
    assert.deepEqual(needs.agentsOf(ws("nothing", { agents: [plain] })), [plain]);
    assert.deepEqual(needs.agentsOf(undefined), []);
  });

  it("never holds an entry saved before the core kept what it saw, until the core rewrites it", () => {
    const w = ws("unseen", { agents: [idle("t", 1000)] });
    assert.equal(one(w)?.status, "idle");
    assert.equal(needs.turnStart(one(w), w), undefined);
  });

  it("keeps cmux's own start when the core saved none", () => {
    assert.equal(one(ws("undated", { agents: [idle("u", 1003)] }))?.sinceEpoch, 1003);
  });

  it("holds with no start on either side, and not with one on only one side", () => {
    assert.equal(one(ws("nostart", { agents: [agent("idle", { id: "n" })] }))?.status, "needs_input");
    assert.equal(one(ws("nostart", { agents: [idle("n", 1000)] }))?.status, "idle");
    assert.equal(one(ws("busy", { agents: [agent("working", { id: "w" })] }))?.sinceEpoch, undefined);
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

  it("drops a saved turn once a prompt comes after it, whichever status follows", () => {
    const idleAfter = ws("turn", { latestAt: 1020, agents: [idle("t", 1030)] });
    assert.equal(one(idleAfter)?.status, "idle");
    assert.equal(needs.turnStart(one(idleAfter), idleAfter), undefined);
    const askAfter = ws("turn", { latestAt: 1020, agents: [asking("t", 1040)] });
    assert.equal(one(askAfter)?.sinceEpoch, 1040, "a later spell keeps its own age");
    assert.equal(needs.turnStart(one(askAfter), askAfter), undefined);
  });

  it("drops a saved turn when a task notification resumes the chat with no prompt and it idles again", () => {
    const w = ws("turn", { latestAt: 900, agents: [idle("t", 1120)] });
    assert.equal(one(w)?.status, "idle");
    assert.equal(one(w)?.sinceEpoch, 1120);
    assert.equal(needs.turnStart(one(w), w), undefined);
  });

  it("keeps a new working spell's own start over a saved working's", () => {
    const w = ws("busy", { agents: [working("w", 2000)] });
    assert.equal(one(w)?.status, "working");
    assert.equal(one(w)?.sinceEpoch, 2000);
  });

  it("drops a stop once its agent has worked and finished again", () => {
    const w = ws("stop", { agents: [idle("s", 1300)] });
    assert.equal(needs.cockpitWait(one(w), w), undefined);
  });

  it("holds a turn through a flap of status inside 3 seconds (a known limit)", () => {
    const w = ws("turn", { agents: [idle("t", 1002.5)] });
    assert.equal(needs.turnStart(one(w), w), 1000, "a spell from 1001 to 1002.5 is not seen");
  });

  it("never keeps a saved turn or idle on a working agent, even with no start", () => {
    const w = ws("turn", { agents: [agent("working", { id: "t" })] });
    assert.equal(one(w)?.status, "working");
    assert.equal(needs.turnStart(one(w), w), undefined);
    assert.equal(one(ws("staleIdle", { agents: [agent("working", { id: "a" })] }))?.status, "working", "nor an idle");
  });

  it("holds a working entry on status alone and shows cmux's start, as the core's is unreliable", () => {
    const w = ws("busy", { agents: [working("w", 1030)] });
    assert.equal(one(w)?.status, "working");
    assert.equal(one(w)?.sinceEpoch, 1030);
    const stop = ws("stopDrift", { agents: [working("s", 930)] });
    assert.equal(needs.cockpitWait(one(stop), stop), "stop", "a silent stop 30 s off the core's start");
    const park = ws("parkDrift", { agents: [working("p", 1030)] });
    assert.equal(needs.cockpitWait(one(park), park), "park", "a park on a lead 30 s off the core's start");
  });

  it("still needs a 3 second match for a turn or an ask", () => {
    const turn = ws("turn", { agents: [idle("t", 1004)] });
    assert.equal(one(turn)?.status, "idle");
    assert.equal(needs.turnStart(one(turn), turn), undefined);
    const ask = ws("asks", { agents: [asking("k", 1004)] });
    assert.equal(one(ask)?.status, "needs_input");
    assert.equal(needs.askReason(one(ask), ask), null);
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
    assert.deepEqual(r.opened, [setUrl("asks", { k: 1000.1234 })]);
    r.data.epoch = 1060 + 3600;
    assert.equal(one(w)?.status, "idle", "the saved entry still says needs_input");
    w.agents = [asking("k", 2000)];
    assert.equal(one(w)?.status, "needs_input", "a new ask shows again");
  });

  it("keeps an earlier dismissal the core has since saved as idle when another is dismissed", () => {
    const w = ws("pair", { agents: [asking("a", 1000), asking("b", 1010)] });
    assert.deepEqual(
      needs.agentsOf(w).map((a) => a.status),
      ["idle", "needs_input"],
    );
    needs.dismissNeeds(w);
    assert.deepEqual(r.opened, [setUrl("pair", { a: 1000, b: 1010 })]);
  });

  it("writes back an ask's dismissal still behind its entry, and drops one whose wait has ended", () => {
    const w = ws("wbAsk", { agents: [asking("a"), asking("b", 1010), idle("c", 1100)] });
    assert.deepEqual(
      needs.agentsOf(w).map((a) => a.status),
      ["idle", "needs_input", "idle"],
    );
    needs.dismissNeeds(w);
    assert.deepEqual(r.opened, [setUrl("wbAsk", { a: 1000.1234, b: 1010 })]);
  });

  it("writes back a turn's dismissal keyed on its move, though the core saved it idle at its own start", () => {
    const w = ws("wbTurn", { agents: [idle("t", 1001.5), idle("o", 1200), asking("b", 1010)] });
    needs.dismissNeeds(w);
    assert.deepEqual(r.opened, [setUrl("wbTurn", { t: 1000, ci: 800, b: 1010 })]);
  });

  it("writes back a dismissal for an agent the core left out of its saved list", () => {
    const w = ws("wbGone", { agents: [idle("g", 1200), asking("b", 1010)] });
    needs.dismissNeeds(w);
    assert.deepEqual(r.opened, [setUrl("wbGone", { g: 900, b: 1010 })]);
  });

  it("keys an undated saved turn on cmux's start, so the dismissal is saved", () => {
    const w = ws("undated", { agents: [idle("u", 1003)] });
    needs.dismissNeeds(w);
    assert.equal(one(w)?.status, "idle");
    assert.deepEqual(r.opened, [setUrl("undated", { u: 1003 })]);
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
    r.data.workspaces = [ws("mv", { selected: true, agents: [idle("t", 1120)] })];
    assert.equal(details.moveDetail(), null, "a turn worked past");
  });

  it("counts a carrier whose wait the waits map holds", () => {
    r.data.workspaces = [ws("stop", { selected: true, agents: [working("s", 900)] })];
    assert.equal(m.currentAsk()?.count, 1);
    assert.equal(m.currentAsk()?.dismissLabel, "");
  });

  it("counts a stop or park on a working agent whose start is 30 s off the core's", () => {
    r.data.workspaces = [ws("stopDrift", { selected: true, agents: [working("s", 930)] })];
    assert.equal(m.currentAsk()?.count, 1);
    assert.equal(m.currentAsk()?.text, "Stopped: on an error");
    assert.equal(needs.agentsOf(m.cur().ws)[0]?.sinceEpoch, 930);
    r.data.workspaces = [ws("parkDrift", { selected: true, agents: [working("p", 1030)] })];
    assert.equal(m.currentAsk()?.text, "Parked: notes-app#42 needs a decision");
  });

  it("reads a carrier whose wait the waits map lacks as cmux sends it, with a working Dismiss", () => {
    r.data.workspaces = [ws("lag", { selected: true, agents: [asking("s", 1000)], latestMessage: "Done." })];
    assert.equal(needs.cockpitWait(m.cur().a, m.cur().ws), undefined);
    assert.equal(m.cur().a?.status, "needs_input");
    assert.equal(m.currentAsk()?.count, 1);
    assert.equal(m.currentAsk()?.dismissLabel, "Dismiss");
    r.data.workspaces = [ws("lag", { selected: true, agents: [idle("s", 1000)], latestMessage: "Done." })];
    assert.equal(m.currentAsk(), null, "nor any ask while cmux says idle");
  });
});
