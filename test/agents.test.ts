import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { installRenderer } from "./support/renderer.ts";

const r = installRenderer();
const { agent, ws } = await import("./support/fixtures.ts");
const m = await import("../src/agents/model.ts");
const { cardMessage } = await import("../src/shared/text.ts");
const { dismissNeeds } = await import("../src/shared/needs.ts");
const { STATUS_DOT, T } = await import("../src/agents/theme.ts");

beforeEach(() => {
  r.data.epoch = 10_000;
  r.data.workspaces = [];
  m.setIdleOpen(false);
});

describe("roster", () => {
  it("uses the most active agent, so a stale idle one never hides a working one", () => {
    r.data.workspaces = [ws("w", { agents: [agent("idle", { lastActivityAt: 50 }), agent("working")] })];
    const { run, idle } = m.roster();
    assert.equal(run.length, 1);
    assert.equal(idle.length, 0);
  });

  it("sorts running oldest first and idle most recent first", () => {
    r.data.workspaces = [
      ws("r-new", { agents: [agent("working", { sinceEpoch: 500 })] }),
      ws("r-old", { agents: [agent("working", { sinceEpoch: 100 })] }),
      ws("i-old", { agents: [agent("idle", { lastActivityAt: 100 })] }),
      ws("i-new", { agents: [agent("idle", { lastActivityAt: 500 })] }),
    ];
    const { run, idle } = m.roster();
    assert.deepEqual(
      run.map((e) => e.ws.id),
      ["r-old", "r-new"],
    );
    assert.deepEqual(
      idle.map((e) => e.ws.id),
      ["i-new", "i-old"],
    );
  });
});

describe("roster leaves out the selected workspace", () => {
  it("drops it from both running and idle", () => {
    r.data.workspaces = [
      ws("sel-run", { selected: true, agents: [agent("working")] }),
      ws("other-run", { agents: [agent("working")] }),
      ws("other-idle", { agents: [agent("idle")] }),
    ];
    const { run, idle } = m.roster();
    assert.deepEqual(
      run.map((e) => e.ws.id),
      ["other-run"],
    );
    assert.deepEqual(
      idle.map((e) => e.ws.id),
      ["other-idle"],
    );
  });

  it("drops a selected idle workspace too", () => {
    r.data.workspaces = [ws("sel", { selected: true, agents: [agent("idle")] })];
    assert.equal(m.roster().idle.length, 0);
  });
});

describe("workingRows and idleRows", () => {
  const idleWorkspaces = (n: number) =>
    Array.from({ length: n }, (_, i) => ws("i" + i, { agents: [agent("idle", { lastActivityAt: i })] }));

  it("puts working and idle in their own lists, with no heading or empty rows", () => {
    r.data.workspaces = [ws("r", { agents: [agent("working")] }), ...idleWorkspaces(1)];
    assert.deepEqual(
      m.workingRows().map((e) => [e.kind, e.last]),
      [["run", true]],
    );
    assert.deepEqual(
      m.idleRows().map((e) => [e.kind, e.last]),
      [["idle", true]],
    );
  });

  it("is empty on both sides when nothing is there, so each section shows only its heading", () => {
    assert.deepEqual(m.workingRows(), []);
    assert.deepEqual(m.idleRows(), []);
  });

  it("shows three idle inline, then a toggle for the rest", () => {
    r.data.workspaces = idleWorkspaces(5);
    assert.deepEqual(
      m.idleRows().map((e) => e.kind),
      ["idle", "idle", "idle", "toggle"],
    );
    const toggle = m.idleRows().at(-1);
    assert.equal(toggle?.kind === "toggle" && toggle.count, 2);
  });

  it("expands to every idle agent", () => {
    r.data.workspaces = idleWorkspaces(5);
    m.setIdleOpen(true);
    assert.equal(m.idleRows().filter((e) => e.kind === "idle").length, 5);
  });

  it("flags only each list's final row as last", () => {
    r.data.workspaces = [ws("r1", { agents: [agent("working")] }), ws("r2", { agents: [agent("working")] })];
    assert.deepEqual(
      m.workingRows().map((e) => e.last),
      [false, true],
    );
  });

  it("leaves Working empty when the only worker is the selected workspace", () => {
    r.data.workspaces = [ws("sel", { selected: true, agents: [agent("working")] })];
    assert.deepEqual(m.workingRows(), []);
  });
});

describe("sinceAge", () => {
  it("writes working and idle rows in one format", () => {
    assert.equal(m.sinceAge(agent("working", { sinceEpoch: 10_000 - 30 })), "<1m");
    assert.equal(m.sinceAge(agent("idle", { sinceEpoch: 1, lastActivityAt: 10_000 - 46 })), "<1m");
    assert.equal(m.sinceAge(agent("working", { sinceEpoch: 10_000 - 720 })), "12m");
    assert.equal(m.sinceAge(agent("idle", { lastActivityAt: 10_000 - 7200 })), "2h");
  });

  it("is blank without an agent or a timestamp", () => {
    assert.equal(m.sinceAge(null), "");
    assert.equal(m.sinceAge(agent("idle")), "");
  });
});

describe("rosterAge", () => {
  it("counts a working row from its start only, and an idle row from its last activity", () => {
    const run = (a: Agent) => ({ key: "r", kind: "run" as const, ws: ws("w"), a, project: m.cur().project });
    const idle = (a: Agent) => ({ key: "i", kind: "idle" as const, ws: ws("w"), a, project: m.cur().project });
    assert.equal(m.rosterAge(run(agent("working", { sinceEpoch: 10_000 - 720 }))), "12m");
    // No start: blank, never the last activity, which resets while it works.
    assert.equal(m.rosterAge(run(agent("working", { lastActivityAt: 10_000 - 5 }))), "");
    assert.equal(m.rosterAge(idle(agent("idle", { sinceEpoch: 1, lastActivityAt: 10_000 - 46 }))), "<1m");
  });
});

describe("headStatus", () => {
  it("says the status in words beside its age", () => {
    assert.equal(m.headStatus(agent("working", { sinceEpoch: 10_000 - 840 })), "Working 14m");
    assert.equal(m.headStatus(agent("needs_input", { sinceEpoch: 10_000 - 5 })), "Needs you <1m");
    assert.equal(m.headStatus(agent("idle", { lastActivityAt: 10_000 - 120 })), "Idle 2m");
    assert.equal(m.headStatus(agent("ended", { lastActivityAt: 10_000 - 180 })), "Ended 3m ago");
  });

  it("says the word alone without a time, and No agent without an agent", () => {
    assert.equal(m.headStatus(agent("ended")), "Ended");
    assert.equal(m.headStatus(null), "No agent");
  });
});

describe("the card's details", () => {
  it("shows the details block only while a line has something to say", () => {
    r.data.workspaces = [ws("sel", { selected: true })];
    assert.equal(m.hasDetails(), false);
    r.data.workspaces = [ws("sel", { selected: true, ports: [3000] })];
    assert.equal(m.hasDetails(), true);
    r.data.workspaces = [ws("sel", { selected: true, dirty: true })];
    assert.equal(m.hasDetails(), true);
    r.data.workspaces = [ws("sel", { selected: true, pr: { number: 1, url: "u/1", status: "open" } })];
    assert.equal(m.hasDetails(), true);
  });

  it("says the branch and uncommitted changes when dirty, never a file count", () => {
    r.data.workspaces = [ws("sel", { selected: true, branch: "main", dirty: true })];
    assert.equal(m.branchDetail(), "main · uncommitted changes");
  });

  it("says the branch alone when clean, changes alone with no branch, and nothing with neither", () => {
    r.data.workspaces = [ws("sel", { selected: true, branch: "main" })];
    assert.equal(m.branchDetail(), "main");
    r.data.workspaces = [ws("sel", { selected: true, dirty: true })];
    assert.equal(m.branchDetail(), "uncommitted changes");
    r.data.workspaces = [ws("sel", { selected: true })];
    assert.equal(m.branchDetail(), "");
  });

  it("lists at most three ports, each with its local address", () => {
    r.data.workspaces = [ws("sel", { selected: true, ports: [5173, 3000, 8080, 9000] })];
    assert.deepEqual(
      m.portChips().map((p) => [p.label, p.url]),
      [
        [":5173", "http://localhost:5173"],
        [":3000", "http://localhost:3000"],
        [":8080", "http://localhost:8080"],
      ],
    );
    r.data.workspaces = [ws("sel", { selected: true })];
    assert.deepEqual(m.portChips(), []);
  });

  it("gives the PR with its state", () => {
    r.data.workspaces = [ws("sel", { selected: true, pr: { number: 12, url: "u/12", status: "open", draft: true } })];
    assert.equal(m.currentPr()?.text, "#12 · draft");
    r.data.workspaces = [ws("sel", { selected: true })];
    assert.equal(m.currentPr(), undefined);
  });
});

describe("current", () => {
  it("follows the selected workspace", () => {
    r.data.workspaces = [ws("a"), ws("b", { selected: true, agents: [agent("idle"), agent("working")] })];
    assert.equal(m.current()?.ws.id, "b");
    assert.equal(m.current()?.a?.status, "working");
    assert.equal(m.cur().agents.length, 2);
  });

  it("is null with no selection, and cur() stands in", () => {
    r.data.workspaces = [ws("a")];
    assert.equal(m.current(), null);
    assert.equal(m.cur().a, null);
  });
});

describe("cardMessage (shared/text)", () => {
  it("hides a message that only echoes the prompt", () => {
    assert.equal(cardMessage(ws("a", { latestMessage: "Fix the build", latestPrompt: " Fix  the build " })), "");
  });

  it("keeps a message that differs from the prompt, or has no prompt", () => {
    assert.equal(
      cardMessage(ws("a", { latestMessage: "Done, tests pass", latestPrompt: "Fix it" })),
      "Done, tests pass",
    );
    assert.equal(cardMessage(ws("a", { latestMessage: "Done, tests pass" })), "Done, tests pass");
  });

  it("is empty when there is no readable message", () => {
    assert.equal(cardMessage(ws("a", { latestPrompt: "Fix it" })), "");
  });

  it("treats a missing workspace as no message", () => {
    assert.equal(cardMessage(undefined), "");
  });
});

describe("currentAsk", () => {
  const selected = (a: Agent, extra: Partial<Workspace> = {}) => ws("sel", { selected: true, agents: [a], ...extra });

  it("carries the agent's words when the selected workspace needs you", () => {
    const a = agent("needs_input", { sinceEpoch: 900, surfaceId: "s1" });
    r.data.workspaces = [selected(a, { latestMessage: "Shall I push?", latestPrompt: "Fix it" })];
    assert.deepEqual(m.currentAsk(), { a, text: "Shall I push?", count: 1, canAnswer: true, dismissLabel: "Dismiss" });
  });

  it("offers Answer only when the asker has a terminal to focus", () => {
    r.data.workspaces = [selected(agent("needs_input"), { latestMessage: "Shall I push?" })];
    assert.equal(m.currentAsk()?.canAnswer, false);
    assert.equal(m.currentAsk()?.dismissLabel, "Dismiss");
  });

  it("shows the workspace message only when the asker is the one live agent", () => {
    const asker = agent("needs_input", { surfaceId: "s1" });
    r.data.workspaces = [
      ws("sel", { selected: true, agents: [asker, agent("ended")], latestMessage: "Shall I push?" }),
    ];
    assert.equal(m.currentAsk()?.text, "Shall I push?");
    r.data.workspaces = [ws("sel", { selected: true, agents: [asker, agent("working")], latestMessage: "Built it" })];
    assert.equal(m.currentAsk()?.text, "");
    assert.equal(m.currentAsk()?.count, 1);
  });

  it("counts several askers and says Dismiss all", () => {
    r.data.workspaces = [
      ws("sel", {
        selected: true,
        agents: [agent("needs_input"), agent("needs_input"), agent("idle")],
        latestMessage: "Shall I push?",
      }),
    ];
    const ask = m.currentAsk();
    assert.equal(ask?.count, 2);
    assert.equal(ask?.text, "2 agents are asking");
    assert.equal(ask?.dismissLabel, "Dismiss all");
  });

  it("picks the asker with the latest activity", () => {
    const older = agent("needs_input", { lastActivityAt: 100, surfaceId: "old" });
    const newer = agent("needs_input", { lastActivityAt: 500, surfaceId: "new" });
    r.data.workspaces = [ws("sel", { selected: true, agents: [older, newer] })];
    assert.equal(m.currentAsk()?.a.id, newer.id);
    assert.equal(m.currentAsk()?.a.surfaceId, "new");
  });

  it("has no text when there is only the generic fallback", () => {
    r.data.workspaces = [
      selected(agent("needs_input"), { latestMessage: "Please fix it\n", latestPrompt: "Please  fix it" }),
    ];
    assert.equal(m.currentAsk()?.text, "");
    r.data.workspaces = [selected(agent("needs_input"), { latestMessage: "/private/tmp/out.txt" })];
    assert.equal(m.currentAsk()?.text, "");
  });

  it("is null when the agent does not need you, or nothing is selected", () => {
    r.data.workspaces = [selected(agent("working"), { latestMessage: "Building" })];
    assert.equal(m.currentAsk(), null);
    r.data.workspaces = [ws("other", { agents: [agent("needs_input")] })];
    assert.equal(m.currentAsk(), null);
  });

  it("follows the most active agent, as the Needs you strip does", () => {
    r.data.workspaces = [ws("sel", { selected: true, agents: [agent("idle"), agent("needs_input")] })];
    assert.equal(m.currentAsk()?.a.status, "needs_input");
  });

  it("is null for the idle nudge and for a dismissed ask", () => {
    const nudge = agent("needs_input", { kind: "claude", lastActivityAt: 1000, sinceEpoch: 1060 });
    r.data.workspaces = [selected(nudge)];
    assert.equal(m.currentAsk(), null);
    const w = selected(agent("needs_input", { sinceEpoch: 700 }), { id: "dis" });
    r.data.workspaces = [w];
    dismissNeeds(w);
    assert.equal(m.currentAsk(), null);
  });
});

describe("cardLine", () => {
  it("shows the message while nothing is asked", () => {
    r.data.workspaces = [ws("sel", { selected: true, agents: [agent("working")], latestMessage: "Building" })];
    assert.equal(m.cardLine(), "Building");
  });

  it("is empty while the question block carries the words", () => {
    r.data.workspaces = [
      ws("sel", {
        selected: true,
        agents: [agent("needs_input", { sinceEpoch: 900 })],
        latestMessage: "Shall I push?",
      }),
    ];
    assert.equal(m.cardLine(), "");
  });
});

describe("status words", () => {
  it("rows in the card say the status with the coarse age", () => {
    assert.equal(m.statusLine(agent("needs_input", { sinceEpoch: 10_000 - 5 })), "needs you <1m");
    assert.equal(m.statusLine(agent("working", { sinceEpoch: 10_000 - (3 * 3600 + 5 * 60) })), "working 3h");
    assert.equal(m.statusLine(agent("idle", { lastActivityAt: 10_000 - 46 })), "idle <1m");
    assert.equal(m.statusLine(agent("idle")), "idle");
    assert.equal(m.statusLine(null), "");
  });

  it("ageSince is coarse and blank without a timestamp", () => {
    assert.equal(m.ageSince(10_000 - 720), "12m");
    assert.equal(m.ageSince(10_000 - 5), "<1m");
    assert.equal(m.ageSince(undefined), "");
  });

  it("ageSince clamps a timestamp ahead of the clock, and is blank before the first tick", () => {
    assert.equal(m.ageSince(10_000 + 30), "<1m");
    r.data.epoch = 0;
    assert.equal(m.ageSince(500), "");
  });

  it("hollowDot for idle and no agent only", () => {
    assert.equal(m.hollowDot(null), true);
    assert.equal(m.hollowDot(agent("idle")), true);
    assert.equal(m.hollowDot(agent("working")), false);
    assert.equal(m.hollowDot(agent("needs_input")), false);
    assert.equal(m.hollowDot(agent("ended")), false);
  });

  // haloFor is covered in test/halo.test.ts, alongside the shared halo
  // decision it maps and the left sidebar's own mapping of the same one.
});

describe("prs", () => {
  it("de-duplicates by url and orders open, merged, closed, newest first", () => {
    r.data.workspaces = [
      ws("one", {
        prs: [
          { url: "u/1", number: 1, status: "merged" },
          { url: "u/3", number: 3, status: "open" },
        ],
      }),
      ws("two", { pr: { url: "u/3", number: 3, status: "open" } }),
      ws("three", {
        prs: [
          { url: "u/9", number: 9, status: "closed" },
          { url: "u/5", number: 5, status: "open" },
        ],
      }),
      ws("none", { pr: { number: 4, status: "open" } }),
    ];
    assert.deepEqual(
      m.prs().map((e) => e.pr.number),
      [5, 3, 1, 9],
    );
  });

  it("titles from the workspace, else a real label, else the branch", () => {
    r.data.workspaces = [
      ws("t", { title: "✳ Tidy", pr: { url: "u/1", label: "PR" } }),
      ws("l", { title: "", pr: { url: "u/2", label: "Fix bug" } }),
      ws("b", { title: "", pr: { url: "u/3", label: "pr", branch: "feat/x" } }),
    ];
    assert.deepEqual(
      m.prs().map((e) => e.title),
      ["Tidy", "Fix bug", "feat/x"],
    );
  });
});

describe("madeHere", () => {
  it("is empty while nothing has been published", () => {
    r.data.workspaces = [ws("sel", { selected: true })];
    assert.deepEqual(m.madeHere(), []);
  });
});

describe("prChipText", () => {
  it("says draft for an open draft, else the status", () => {
    assert.equal(m.prChipText({ status: "open", draft: true }), "draft");
    assert.equal(m.prChipText({ status: "open" }), "open");
    assert.equal(m.prChipText({ status: "merged", draft: true }), "merged");
    assert.equal(m.prChipText({}), "");
  });

  it("keeps stale inside the chip, with no stray separator", () => {
    assert.equal(m.prChipText({ status: "open", draft: true, stale: true }), "draft · stale");
    assert.equal(m.prChipText({ stale: true }), "stale");
  });
});

describe("subagents", () => {
  const run = (id: string, extra: Partial<SubagentRun> = {}): SubagentRun => ({ id, ...extra });
  const sel = (agents: Agent[]) => {
    r.data.workspaces = [
      ws("other", { agents: [agent("working", { children: [run("x", { running: true })] })] }),
      ws("sel", { selected: true, agents }),
    ];
  };
  const ids = () => m.subagents().map((e) => e.key.split(":")[2]);

  it("is empty with no selection, no agents, or no children", () => {
    assert.deepEqual(m.subagents(), []);
    sel([]);
    assert.deepEqual(m.subagents(), []);
    sel([agent("working")]);
    assert.deepEqual(m.subagents(), []);
  });

  it("puts running runs first, oldest start first, then settled ones newest end first", () => {
    sel([
      agent("working", {
        children: [
          run("old-done", { running: false, startedEpoch: 100, endedEpoch: 200 }),
          run("late", { running: true, startedEpoch: 900 }),
          run("new-done", { running: false, startedEpoch: 100, endedEpoch: 800 }),
          run("early", { running: true, startedEpoch: 300 }),
          run("no-end", { running: false, startedEpoch: 500 }),
        ],
      }),
    ]);
    assert.deepEqual(ids(), ["early", "late", "new-done", "no-end", "old-done"]);
  });

  it("figures coarse elapsed while running, running with no start, and when it finished once settled", () => {
    sel([
      agent("working", {
        children: [
          run("a", { label: "Edge-case review", running: true, startedEpoch: 10_000 - 240 }),
          run("b", { label: "No start yet", running: true }),
          run("c", { label: "Write builder tests", running: false, startedEpoch: 100, endedEpoch: 10_000 - 180 }),
          run("d", { label: "No end sent", running: false, startedEpoch: 50 }),
          run("e", { label: "Just now", running: false, startedEpoch: 60, endedEpoch: 10_000 - 20 }),
        ],
      }),
    ]);
    assert.deepEqual(
      m.subagents().map((e) => [e.label, m.subagentFigure(e)]),
      [
        ["No start yet", "running"],
        ["Edge-case review", "4m"],
        ["Just now", "finished just now"],
        ["Write builder tests", "finished 3m ago"],
        ["No end sent", "finished"],
      ],
    );
  });

  it("dots a running run as working with its halo, a settled one as ended with none", () => {
    sel([agent("working", { children: [run("a", { running: true }), run("b", { running: false })] })]);
    const [live, done] = m.subagents();
    assert.ok(live && done);
    assert.equal(m.subagentDot(live), STATUS_DOT.working);
    assert.equal(m.subagentHalo(live), T.blueHalo);
    assert.equal(m.subagentDot(done), STATUS_DOT.ended);
    assert.equal(m.subagentHalo(done), "clear");
    assert.equal(m.subagentLabelColor(live), T.text);
    assert.equal(m.subagentLabelColor(done), T.tertiary);
  });

  it("settles every run under an ended session, whatever the run says", () => {
    sel([agent("ended", { children: [run("stuck", { running: true, startedEpoch: 100 })] })]);
    assert.deepEqual(
      m.subagents().map((e) => e.running),
      [false],
    );
  });

  it("falls back on a label, on running, and on the index for an id, and skips holes", () => {
    const children = [
      run("live", { startedEpoch: 9_990 }),
      run("gone", { endedEpoch: 9_000 }),
      { startedEpoch: 9_995 },
      null,
    ] as SubagentRun[]; // cmux has sent holes in agent lists; the model must survive one here too.
    sel([agent("working", { children })]);
    assert.deepEqual(
      m.subagents().map((e) => [e.key.split(":")[2], e.label, e.running]),
      [
        ["live", "subagent", true],
        ["#2", "subagent", true],
        ["gone", "subagent", false],
      ],
    );
  });

  it("gathers runs across the workspace's agents with distinct keys, at most 5", () => {
    const three = (p: string) => [0, 1, 2].map((i) => run(p + i, { running: true, startedEpoch: 100 + i }));
    const a1 = agent("working", { children: three("s") });
    const a2 = agent("idle", { children: three("s") });
    sel([a1, a2]);
    const keys = m.subagents().map((e) => e.key);
    assert.equal(keys.length, 5);
    assert.equal(new Set(keys).size, 5);
    assert.ok(keys.some((k) => k.startsWith("s:" + a2.id + ":")));
  });
});

describe("agentRows", () => {
  it("hides ended agents and shows no list with only one live agent", () => {
    r.data.workspaces = [
      ws("w", {
        selected: true,
        agents: [agent("working", { name: "Claude" }), agent("ended", { name: "Claude" }), agent("ended")],
      }),
    ];
    assert.deepEqual(m.agentRows(), []);
  });

  it("numbers agents sharing a fallback label in cmux's order, and a real title wins", () => {
    const first = agent("idle", { name: "Claude", lastActivityAt: 100 });
    const second = agent("working", { name: "Claude" });
    const titled = agent("idle", { name: "Claude", title: "Fix the poller", lastActivityAt: 50 });
    const gone = agent("ended", { name: "Claude" });
    r.data.workspaces = [ws("w", { selected: true, agents: [first, gone, second, titled] })];
    const rows = m.agentRows();
    // Most active first; numbers follow cmux's order, ended agents included.
    assert.deepEqual(
      rows.map((e) => [e.key, e.label, e.last]),
      [
        ["a:" + second.id, "Claude 3", false],
        ["a:" + first.id, "Claude 1", false],
        ["a:" + titled.id, "Fix the poller", true],
      ],
    );
  });

  it("keeps each agent's number when an earlier one ends", () => {
    const one = agent("working", { name: "Claude" });
    const two = agent("idle", { name: "Claude", lastActivityAt: 100 });
    const three = agent("idle", { name: "Claude", lastActivityAt: 50 });
    r.data.workspaces = [ws("w", { selected: true, agents: [one, two, three] })];
    assert.deepEqual(
      m.agentRows().map((e) => e.label),
      ["Claude 1", "Claude 2", "Claude 3"],
    );
    one.status = "ended";
    r.data.workspaces = [ws("w", { selected: true, agents: [one, two, three] })];
    assert.deepEqual(
      m.agentRows().map((e) => e.label),
      ["Claude 2", "Claude 3"],
    );
  });

  it("leaves a unique fallback label unnumbered", () => {
    r.data.workspaces = [
      ws("w", { selected: true, agents: [agent("working", { name: "Claude" }), agent("idle", { kind: "codex" })] }),
    ];
    assert.deepEqual(
      m.agentRows().map((e) => e.label),
      ["Claude", "codex"],
    );
  });

  it("caps at six rows", () => {
    r.data.workspaces = [ws("w", { selected: true, agents: Array.from({ length: 8 }, () => agent("idle")) })];
    const rows = m.agentRows();
    assert.equal(rows.length, 6);
    assert.equal(rows[0]?.label, "agent 1");
  });
});
