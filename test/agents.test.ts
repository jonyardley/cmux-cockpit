import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { installRenderer } from "./support/renderer.ts";

const r = installRenderer();
const { agent, ws } = await import("./support/fixtures.ts");
const m = await import("../src/agents/model.ts");
const lists = await import("../src/agents/lists.ts");
const team = await import("../src/agents/team.ts");
const prList = await import("../src/agents/pr-list.ts");
const made = await import("../src/agents/made.ts");
const { ageSince } = await import("../src/shared/time.ts");
const { cardMessage } = await import("../src/shared/text.ts");
const { dismissNeeds } = await import("../src/shared/needs.ts");
const { summaryOf } = await import("../src/shared/prs.ts");
const { liveRunCount } = await import("../src/shared/subagents.ts");
const { countTint } = await import("../src/shared/ui.ts");
const { P } = await import("../src/shared/palette.ts");

beforeEach(() => {
  r.data.epoch = 10_000;
  r.data.workspaces = [];
  r.data.groups = [];
});

describe("currentHeading", () => {
  it("names the selected workspace's project after the heading", () => {
    r.data.workspaces = [ws("sel", { selected: true, directory: "/Users/coder/Dev/App-One/app" })];
    assert.equal(m.currentHeading(), "THIS WORKSPACE · App One");
  });

  it("says plain THIS WORKSPACE with no project", () => {
    r.data.workspaces = [ws("sel", { selected: true })];
    assert.equal(m.currentHeading(), "THIS WORKSPACE");
    r.data.workspaces = [];
    assert.equal(m.currentHeading(), "THIS WORKSPACE");
  });
});

describe("sinceAge", () => {
  it("writes working and idle rows in one format", () => {
    assert.equal(m.sinceAge(agent("working", { sinceEpoch: 10_000 - 30 })), "<1m");
    assert.equal(m.sinceAge(agent("idle", { sinceEpoch: 10_000 - 46, lastActivityAt: 10_000 - 7200 })), "<1m");
    assert.equal(m.sinceAge(agent("working", { sinceEpoch: 10_000 - 720 })), "12m");
    assert.equal(m.sinceAge(agent("idle", { lastActivityAt: 10_000 - 7200 })), "2h");
  });

  it("is blank without an agent or a timestamp", () => {
    assert.equal(m.sinceAge(null), "");
    assert.equal(m.sinceAge(agent("idle")), "");
  });
});

describe("headStatus", () => {
  it("says the status in words beside its age", () => {
    assert.equal(m.headStatus(agent("working", { sinceEpoch: 10_000 - 840 })), "Working 14m");
    assert.equal(m.headStatus(agent("needs_input", { sinceEpoch: 10_000 - 5 })), "Your turn <1m");
    assert.equal(m.headStatus(agent("idle", { lastActivityAt: 10_000 - 120 })), "Idle 2m");
    assert.equal(m.headStatus(agent("ended", { lastActivityAt: 10_000 - 180 })), "Finished 3m");
    // Issue #98: an idle agent counts from its move to idle, as the cockpit card does.
    assert.equal(m.headStatus(agent("idle", { sinceEpoch: 10_000 - 360, lastActivityAt: 10_000 - 180 })), "Idle 6m");
    // An ended agent counts from its last activity, not the session closing: a
    // terminal closed hours after the work never reads "Finished <1m".
    assert.equal(
      m.headStatus(agent("ended", { sinceEpoch: 10_000 - 5, lastActivityAt: 10_000 - 10_800 })),
      "Finished 3h",
    );
  });

  it("says the word alone without a time, and No agent without an agent", () => {
    assert.equal(m.headStatus(agent("ended")), "Finished");
    // A row says the same words in lower case, as the cockpit's card does.
    assert.equal(m.statusLine(agent("ended", { lastActivityAt: 10_000 - 180 })), "finished 3m");
    assert.equal(m.headStatus(null), "No agent");
  });
});

describe("the card's details", () => {
  it("says the branch and uncommitted changes when dirty, never a file count", () => {
    r.data.workspaces = [ws("sel", { selected: true, branch: "main", dirty: true })];
    assert.equal(m.branchFooter(), "main · uncommitted changes");
  });

  it("says clean only when cmux says so, changes alone with no branch, and nothing with neither", () => {
    r.data.workspaces = [ws("sel", { selected: true, branch: "main", dirty: false })];
    assert.equal(m.branchFooter(), "main · clean");
    // No dirty flag sent: the branch alone, never a claim it is clean.
    r.data.workspaces = [ws("sel", { selected: true, branch: "main" })];
    assert.equal(m.branchFooter(), "main");
    r.data.workspaces = [ws("sel", { selected: true, dirty: true })];
    assert.equal(m.branchFooter(), "uncommitted changes");
    r.data.workspaces = [ws("sel", { selected: true })];
    assert.equal(m.branchFooter(), "");
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

  it("hides a harness turn, open or cut short (#103)", () => {
    const open = '<agent-message from="a1"> [Subagent hand-back] The text below is the final report…';
    assert.equal(cardMessage(ws("a", { latestMessage: open, latestPrompt: open })), "");
    assert.equal(cardMessage(ws("a", { latestMessage: open, latestPrompt: "spawn" })), "");
  });

  it("keeps an agent message that follows a closed context block", () => {
    const msg = "<system-reminder>ctx</system-reminder> Build passed, 3 files changed";
    assert.equal(cardMessage(ws("a", { latestMessage: msg, latestPrompt: "go" })), "Build passed, 3 files changed");
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
    assert.deepEqual(m.currentAsk(), {
      a,
      text: "Shall I push?",
      count: 1,
      canOpenChat: true,
      dismissLabel: "Dismiss",
    });
  });

  it("offers Open chat only when the asker has a terminal to focus", () => {
    r.data.workspaces = [selected(agent("needs_input"), { latestMessage: "Shall I push?" })];
    assert.equal(m.currentAsk()?.canOpenChat, false);
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
    assert.equal(ask?.text, "2 agents need you");
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
    assert.equal(m.statusLine(agent("needs_input", { sinceEpoch: 10_000 - 5 })), "your turn <1m");
    assert.equal(m.statusLine(agent("working", { sinceEpoch: 10_000 - (3 * 3600 + 5 * 60) })), "working 3h");
    assert.equal(m.statusLine(agent("idle", { lastActivityAt: 10_000 - 46 })), "idle <1m");
    assert.equal(m.statusLine(agent("idle")), "idle");
    assert.equal(m.statusLine(null), "");
  });

  // ageSince now lives in src/shared/time.ts, one copy for both sidebars (issue #98).
  it("ageSince is coarse and blank without a timestamp", () => {
    assert.equal(ageSince(10_000 - 720), "12m");
    assert.equal(ageSince(10_000 - 5), "<1m");
    assert.equal(ageSince(undefined), "");
  });

  it("ageSince clamps a timestamp ahead of the clock, and is blank before the first tick", () => {
    assert.equal(ageSince(10_000 + 30), "<1m");
    r.data.epoch = 0;
    assert.equal(ageSince(500), "");
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
      prList.prs().map((e) => e.pr.number),
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
      prList.prs().map((e) => e.title),
      ["Tidy", "Fix bug", "feat/x"],
    );
  });
});

describe("madeHere", () => {
  it("is empty while nothing has been published", () => {
    r.data.workspaces = [ws("sel", { selected: true })];
    assert.deepEqual(made.madeHere(), []);
  });
});

describe("prChipText", () => {
  // A PR with no number has no summary, so the chip falls back on its status.
  const said = (pr: PullRequest) => prList.prChipText({ pr, summary: undefined });

  it("says draft for an open draft, else the status", () => {
    assert.equal(said({ status: "open", draft: true }), "draft");
    assert.equal(said({ status: "open" }), "open");
    assert.equal(said({ status: "merged", draft: true }), "merged");
    assert.equal(said({}), "");
  });

  it("keeps stale inside the chip, with no stray separator", () => {
    assert.equal(said({ status: "open", draft: true, stale: true }), "draft · stale");
    assert.equal(said({ stale: true }), "stale");
  });

  it("says the summary's state for a numbered PR, stale after it", () => {
    const pr: PullRequest = { number: 3, status: "open", draft: true, stale: true };
    const summary = summaryOf(pr, [{ name: "test", state: "pending" }]);
    assert.equal(prList.prChipText({ pr, summary }), "draft · running · stale");
    assert.equal(prList.prChipHealth({ summary }), "running");
    assert.equal(prList.prChipHealth({ summary: undefined }), "quiet");
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
  const ids = () => team.subagents().map((e) => e.key.split(":")[2]);

  it("is empty with no selection, no agents, or no children", () => {
    assert.deepEqual(team.subagents(), []);
    sel([]);
    assert.deepEqual(team.subagents(), []);
    sel([agent("working")]);
    assert.deepEqual(team.subagents(), []);
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

  it("figures a helper's coarse elapsed, or running with no start", () => {
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
      team.helpers().map((e) => [e.label, team.helperAge(e)]),
      [
        ["No start yet", "running"],
        ["Edge-case review", "4m"],
      ],
    );
    assert.equal(team.finishedLine(), "3 finished earlier");
  });

  it("settles every run under an ended session, whatever the run says", () => {
    sel([agent("ended", { children: [run("stuck", { running: true, startedEpoch: 100 })] })]);
    assert.deepEqual(
      team.subagents().map((e) => e.running),
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
      team.subagents().map((e) => [e.key.split(":")[2], e.label, e.running]),
      [
        ["live", "subagent", true],
        ["#2", "subagent", true],
        ["gone", "subagent", false],
      ],
    );
  });

  it("gathers runs across the workspace's agents with distinct keys, and lists at most 5 helpers", () => {
    const three = (p: string) => [0, 1, 2].map((i) => run(p + i, { running: true, startedEpoch: 100 + i }));
    const a1 = agent("working", { children: three("s") });
    const a2 = agent("idle", { children: three("s") });
    sel([a1, a2]);
    const keys = team.subagents().map((e) => e.key);
    assert.equal(keys.length, 6);
    assert.equal(new Set(keys).size, 6);
    assert.ok(keys.some((k) => k.startsWith("s:" + a2.id + ":")));
    assert.equal(team.helpers().length, 5);
    assert.equal(team.helperMore(), 1);
  });
});

describe("helpers and finishedLine", () => {
  const run = (id: string, extra: Partial<SubagentRun> = {}): SubagentRun => ({ id, ...extra });
  const sel = (children: SubagentRun[]) => {
    r.data.workspaces = [ws("sel", { selected: true, agents: [agent("working", { children })] })];
  };

  it("lists only the running runs, by label, oldest start first", () => {
    sel([
      run("a", { label: "Write builder tests", running: false, startedEpoch: 100, endedEpoch: 200 }),
      run("b", { label: "Edge-case review", running: true, startedEpoch: 900 }),
      run("c", { label: "Explore the bridge", running: true, startedEpoch: 300 }),
    ]);
    assert.deepEqual(
      team.helpers().map((e) => e.label),
      ["Explore the bridge", "Edge-case review"],
    );
    assert.equal(team.finishedLine(), "1 finished earlier");
    assert.equal(team.hasHelpers(), true);
  });

  it("with only settled runs, shows no Helpers heading, just the one finished line", () => {
    sel([
      run("a", { running: false, endedEpoch: 200 }),
      run("b", { running: false, endedEpoch: 300 }),
      run("c", { running: false, endedEpoch: 400 }),
    ]);
    assert.deepEqual(team.helpers(), []);
    assert.equal(team.hasHelpers(), false);
    assert.equal(team.finishedLine(), "3 finished earlier");
  });

  it("counts only the settled runs of sessions still open", () => {
    r.data.workspaces = [
      ws("sel", {
        selected: true,
        agents: [
          agent("ended", { children: [run("old1", { running: false }), run("old2", { running: false })] }),
          agent("working", { children: [run("now", { running: false, endedEpoch: 300 })] }),
        ],
      }),
    ];
    assert.equal(team.finishedLine(), "1 finished earlier");
    r.data.workspaces = [ws("sel", { selected: true, agents: [agent("ended", { children: [run("old")] })] })];
    assert.equal(team.finishedLine(), "");
  });

  it("ends the lines in +N more past five running, so they add up to the left card's count", () => {
    sel(Array.from({ length: 8 }, (_, i) => run("r" + i, { running: true, startedEpoch: 100 + i })));
    assert.equal(team.helpers().length, 5);
    assert.equal(team.helperMore(), 3);
    assert.equal(team.helpers().length + team.helperMore(), liveRunCount(m.cur().ws));
    sel([run("a", { running: true })]);
    assert.equal(team.helperMore(), 0);
  });

  it("counts every running run in the heading's pill, past the cap too, and none settled", () => {
    sel([
      ...Array.from({ length: 7 }, (_, i) => run("r" + i, { running: true, startedEpoch: 100 + i })),
      run("done", { running: false, endedEpoch: 300 }),
    ]);
    assert.equal(team.helperCount(), 7);
    assert.equal(team.helperCount(), team.helpers().length + team.helperMore());
    assert.equal(team.helperCount(), liveRunCount(m.cur().ws));
    assert.equal(team.hasHelpers(), true);
    sel([]);
    assert.equal(team.helperCount(), 0);
    assert.equal(team.hasHelpers(), false);
  });

  it("tints the helpers pill working blue, by the shared count tint", () => {
    assert.deepEqual(team.HELPER_PILL, { bg: P.blueCount, fg: P.blueText });
    assert.deepEqual(team.HELPER_PILL, countTint("working"));
  });

  it("says nothing finished when none has, and hides the block with no runs", () => {
    sel([run("a", { running: true, startedEpoch: 100 })]);
    assert.equal(team.finishedLine(), "");
    sel([]);
    assert.equal(team.finishedLine(), "");
    assert.equal(team.hasHelpers(), false);
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
    assert.deepEqual(team.agentRows(), []);
  });

  it("numbers agents sharing a fallback label in cmux's order, and a real title wins", () => {
    const first = agent("idle", { name: "Claude", lastActivityAt: 100 });
    const second = agent("working", { name: "Claude" });
    const titled = agent("idle", { name: "Claude", title: "Fix the poller", lastActivityAt: 50 });
    const gone = agent("ended", { name: "Claude" });
    r.data.workspaces = [ws("w", { selected: true, agents: [first, gone, second, titled] })];
    const rows = team.agentRows();
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
      team.agentRows().map((e) => e.label),
      ["Claude 1", "Claude 2", "Claude 3"],
    );
    one.status = "ended";
    r.data.workspaces = [ws("w", { selected: true, agents: [one, two, three] })];
    assert.deepEqual(
      team.agentRows().map((e) => e.label),
      ["Claude 2", "Claude 3"],
    );
  });

  it("leaves a unique fallback label unnumbered", () => {
    r.data.workspaces = [
      ws("w", { selected: true, agents: [agent("working", { name: "Claude" }), agent("idle", { kind: "codex" })] }),
    ];
    assert.deepEqual(
      team.agentRows().map((e) => e.label),
      ["Claude", "codex"],
    );
  });

  it("caps at six rows", () => {
    r.data.workspaces = [ws("w", { selected: true, agents: Array.from({ length: 8 }, () => agent("idle")) })];
    const rows = team.agentRows();
    assert.equal(rows.length, 6);
    assert.equal(rows[0]?.label, "agent 1");
  });
});

// Opens a card for the body only, folding it again even when an assertion
// fails, so the open state never leaks into later tests.
function whileOpen(k: "prs" | "made", body: () => void): void {
  lists.toggleExpanded(k);
  try {
    body();
  } finally {
    lists.toggleExpanded(k);
  }
}

describe("group placeholders", () => {
  it("leaves out a PR cmux pins on a group's placeholder workspace", () => {
    r.data.workspaces = [
      ws("anchor", { title: "For review", pr: { url: "u/old", number: 2163, status: "merged" } }),
      ws("real", { title: "Some chat", pr: { url: "u/new", number: 7, status: "open" } }),
    ];
    r.data.groups = [{ id: "g", name: "For review", anchorId: "anchor" }];
    assert.deepEqual(
      prList.prs().map((e) => e.pr.number),
      [7],
    );
    assert.equal(prList.prCount(), 1);
  });

  it("leaves it out with no group list, by its lane title alone, even with an agent asking", () => {
    r.data.workspaces = [
      ws("anchor", {
        title: "For review",
        agents: [agent("needs_input")],
        pr: { url: "u/old", number: 2163, status: "merged" },
      }),
    ];
    assert.equal(prList.prCount(), 0);
  });

  it("keeps a lane-titled chat's PR while the group list says it is not the anchor", () => {
    r.data.workspaces = [
      ws("anchor", { title: "Background" }),
      ws("chat", { title: "Parked", pr: { url: "u/1", number: 1, status: "open" } }),
    ];
    r.data.groups = [{ id: "g", name: "Background", anchorId: "anchor" }];
    assert.equal(prList.prCount(), 1);
  });

  it("keeps the PR of a real workspace a group is anchored on", () => {
    r.data.workspaces = [ws("real", { title: "Some chat", pr: { url: "u/1", number: 1, status: "open" } })];
    r.data.groups = [{ id: "g", name: "For review", anchorId: "real" }];
    assert.equal(prList.prCount(), 1);
  });

  it("keeps the PR of a group Jon made himself, titled after it", () => {
    r.data.workspaces = [ws("mine", { title: "my group", pr: { url: "u/1", number: 1, status: "open" } })];
    r.data.groups = [{ id: "g", name: "my group", anchorId: "mine" }];
    assert.equal(prList.prCount(), 1);
  });
});

describe("honest counts and +N more (#80)", () => {
  it("counts every PR before the cap and says how many the cap leaves out", () => {
    r.data.workspaces = Array.from({ length: 8 }, (_, i) =>
      ws("p" + i, { pr: { url: "u/" + i, number: i + 1, status: "open" } }),
    );
    assert.equal(prList.prCount(), 8);
    assert.equal(prList.prFoot(), "+3 more");
    assert.equal(prList.prs().length, 5);
    assert.ok(prList.prs().every((e) => !e.last));
  });

  it("has nothing more to say for a short PR list", () => {
    r.data.workspaces = [ws("p", { pr: { url: "u/1", number: 1, status: "open" } })];
    assert.equal(prList.prCount(), 1);
    assert.equal(prList.prFoot(), "");
    assert.deepEqual(
      prList.prs().map((e) => e.last),
      [true],
    );
  });

  it("opens the PR card past its cap on a tap, and folds it back (#109)", () => {
    r.data.workspaces = Array.from({ length: 8 }, (_, i) =>
      ws("p" + i, { pr: { url: "u/" + i, number: i + 1, status: "open" } }),
    );
    assert.equal(prList.prFoot(), "+3 more");
    whileOpen("prs", () => {
      assert.equal(prList.prs().length, 8);
      assert.equal(prList.prFoot(), "Show less");
      // The Show less line follows, so the final row keeps its rule.
      assert.ok(prList.prs().every((e) => !e.last));
    });
    assert.equal(prList.prs().length, 5);
    assert.equal(prList.prFoot(), "+3 more");
  });

  it("has no closing line for an open PR card that fits its cap", () => {
    r.data.workspaces = [ws("p", { pr: { url: "u/1", number: 1, status: "open" } })];
    whileOpen("prs", () => {
      assert.equal(prList.prFoot(), "");
      assert.deepEqual(
        prList.prs().map((e) => e.last),
        [true],
      );
    });
  });

  it("footText reads +N more while cut, Show less while open, nothing when it fits", () => {
    assert.equal(lists.footText(2, false), "+2 more");
    assert.equal(lists.footText(2, true), "Show less");
    assert.equal(lists.footText(0, false), "");
    assert.equal(lists.footText(0, true), "");
  });

  it("moreThan is never negative", () => {
    assert.equal(lists.moreThan(3, 5), 0);
    assert.equal(lists.moreThan(7, 5), 2);
  });

  it("markLastBefore leaves no row last while more follow", () => {
    assert.deepEqual(
      lists.markLastBefore([{ k: 1 }, { k: 2 }], 1).map((e) => e.last),
      [false, false],
    );
    assert.deepEqual(
      lists.markLastBefore([{ k: 1 }, { k: 2 }], 0).map((e) => e.last),
      [false, true],
    );
  });
});

describe("the PR rows' source", () => {
  it("marks cmux's own PRs as not the poller's, so they never dim", () => {
    r.data.workspaces = [ws("p", { pr: { url: "u/1", number: 1, status: "open" } })];
    const [row] = prList.prs();
    assert.equal(row?.saved, false);
    assert.equal(row && prList.prDim(row), false);
  });

  it("says nothing under the heading and dims nothing with no poll saved", () => {
    assert.equal(prList.prNote(), "");
    assert.equal(prList.prDim({ saved: true }), false);
    r.data.workspaces = [ws("sel", { selected: true, pr: { url: "u/1", number: 1, status: "open" } })];
    assert.equal(m.currentPrDim(), false);
  });
});

describe("emptyNote (#80)", () => {
  it("names both when the selected workspace's agent has no helpers and nothing was published", () => {
    r.data.workspaces = [ws("sel", { selected: true, agents: [agent("working")] })];
    assert.equal(made.emptyNote(), "No helpers or published links yet");
  });

  it("claims no helpers only while the selected workspace has a live agent", () => {
    r.data.workspaces = [ws("sel", { selected: true })];
    assert.equal(made.emptyNote(), "No published links yet");
    r.data.workspaces = [ws("sel", { selected: true, agents: [agent("ended")] })];
    assert.equal(made.emptyNote(), "No published links yet");
  });

  it("claims nothing about published links before the clock's first tick", () => {
    r.data.epoch = 0;
    r.data.workspaces = [ws("sel", { selected: true })];
    assert.equal(made.emptyNote(), "");
  });

  it("names only published links when no workspace is selected", () => {
    r.data.workspaces = [ws("other")];
    assert.equal(made.emptyNote(), "No published links yet");
  });

  it("names only published links while the selected workspace has helpers", () => {
    r.data.workspaces = [
      ws("sel", {
        selected: true,
        agents: [agent("working", { children: [{ id: "c1", label: "Explore", running: true }] })],
      }),
    ];
    assert.equal(made.emptyNote(), "No published links yet");
  });
});

describe("askedLine (#80)", () => {
  it("gives the selected workspace's last prompt, cleaned", () => {
    r.data.workspaces = [
      ws("sel", {
        selected: true,
        latestPrompt: "Fix the chip colours <task-notification>x</task-notification>",
        latestMessage: "Done",
      }),
    ];
    assert.equal(m.askedLine(), "Fix the chip colours");
    assert.equal(m.cardLine(), "Done");
  });

  it("is empty with no prompt, or one with nothing to read", () => {
    r.data.workspaces = [ws("sel", { selected: true })];
    assert.equal(m.askedLine(), "");
    r.data.workspaces = [ws("sel", { selected: true, latestPrompt: "/private/tmp/x.txt" })];
    assert.equal(m.askedLine(), "");
  });

  it("keeps Jon's last prompt when a subagent's hand-back arrives (#103)", () => {
    r.data.workspaces = [ws("sel", { selected: true, latestPrompt: "spawn" })];
    assert.equal(m.askedLine(), "spawn");
    r.data.workspaces = [
      ws("sel", {
        selected: true,
        latestPrompt: "[Subagent hand-back] The text below is the final report of a subagent.\n  done two",
      }),
    ];
    assert.equal(m.askedLine(), "spawn");
  });

  it("finds the frame behind stripped markup, and hides it with no earlier prompt", () => {
    r.data.workspaces = [
      ws("fresh", {
        selected: true,
        latestPrompt: "<system-reminder>x</system-reminder>\n[Subagent hand-back] The text below is a report.",
      }),
    ];
    assert.equal(m.askedLine(), "");
  });

  it("keeps Jon's prompt through the tagged turns cmux cuts to 240 characters", () => {
    r.data.workspaces = [ws("cut", { selected: true, latestPrompt: "spawn" })];
    assert.equal(m.askedLine(), "spawn");
    r.data.workspaces = [
      ws("cut", {
        selected: true,
        latestPrompt: '<agent-message from="a1"> [Subagent hand-back] The text below is the final report…',
      }),
    ];
    assert.equal(m.askedLine(), "spawn");
    r.data.workspaces = [
      ws("cut", {
        selected: true,
        latestPrompt: "<task-notification> <task-id>a1</task-id> <output-file>/private/tmp/tasks/a1.output…",
      }),
    ];
    assert.equal(m.askedLine(), "spawn");
  });

  it("shows a typed prompt behind a closed context block, and skips local command output", () => {
    r.data.workspaces = [
      ws("ctx", { selected: true, latestPrompt: "<system-reminder>ctx</system-reminder>\nRun the tests" }),
    ];
    assert.equal(m.askedLine(), "Run the tests");
    r.data.workspaces = [
      ws("ctx", { selected: true, latestPrompt: "<local-command-stdout>Reloaded</local-command-stdout>" }),
    ];
    assert.equal(m.askedLine(), "Run the tests");
  });

  it("treats an interrupt or an artifact comment as a harness turn", () => {
    r.data.workspaces = [ws("other", { selected: true, latestPrompt: "[Request interrupted by user]" })];
    assert.equal(m.askedLine(), "");
    r.data.workspaces = [ws("other", { selected: true, latestPrompt: "[Artifact comment sent to Claude] Fix this" })];
    assert.equal(m.askedLine(), "");
  });

  it("shows a prompt that only mentions the frame mid-sentence", () => {
    r.data.workspaces = [ws("sel", { selected: true, latestPrompt: "Explain the [Subagent hand-back] frame" })];
    assert.equal(m.askedLine(), "Explain the [Subagent hand-back] frame");
  });

  it("still shows the prompt when the message only echoes it", () => {
    r.data.workspaces = [ws("sel", { selected: true, latestPrompt: "Run the tests", latestMessage: "Run the tests" })];
    assert.equal(m.askedLine(), "Run the tests");
    assert.equal(m.cardLine(), "");
  });
});

describe("stateNotice without the build's flag", () => {
  it("says nothing when no build or test set __STATE_UNREADABLE__", async () => {
    const { stateNotice } = await import("../src/shared/freshness.ts");
    assert.equal(stateNotice(), "");
  });
});
