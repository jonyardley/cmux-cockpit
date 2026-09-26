import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { installRenderer } from "./support/renderer.ts";

const r = installRenderer();
const { agent, ws } = await import("./support/fixtures.ts");
const m = await import("../src/agents/model.ts");
const { cardMessage } = await import("../src/shared/text.ts");

beforeEach(() => {
  r.data.epoch = 10_000;
  r.data.workspaces = [];
  m.setIdleOpen(false);
});

describe("waiting", () => {
  it("lists needs_input workspaces, longest-waiting first, last row flagged", () => {
    r.data.workspaces = [
      ws("new", { agents: [agent("needs_input", { sinceEpoch: 900 })] }),
      ws("busy", { agents: [agent("working")] }),
      ws("old", { agents: [agent("needs_input", { sinceEpoch: 100 })] }),
    ];
    const rows = m.waiting();
    assert.deepEqual(
      rows.map((e) => e.ws.id),
      ["old", "new"],
    );
    assert.deepEqual(
      rows.map((e) => e.last),
      [false, true],
    );
  });

  it("caps at 20", () => {
    r.data.workspaces = Array.from({ length: 25 }, (_, i) => ws("w" + i, { agents: [agent("needs_input")] }));
    assert.equal(m.waiting().length, 20);
  });
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

describe("runningRows", () => {
  const idleWorkspaces = (n: number) =>
    Array.from({ length: n }, (_, i) => ws("i" + i, { agents: [agent("idle", { lastActivityAt: i })] }));

  it("shows Nothing running, three idle inline, then a toggle for the rest", () => {
    r.data.workspaces = idleWorkspaces(5);
    const kinds = m.runningRows().map((e) => e.kind);
    assert.deepEqual(kinds, ["empty", "idle", "idle", "idle", "toggle"]);
    const toggle = m.runningRows().at(-1);
    assert.equal(toggle?.kind === "toggle" && toggle.count, 2);
  });

  it("expands to every idle agent", () => {
    r.data.workspaces = idleWorkspaces(5);
    m.setIdleOpen(true);
    assert.equal(m.runningRows().filter((e) => e.kind === "idle").length, 5);
  });

  it("stands in an empty row when nothing runs, and it reads last", () => {
    assert.deepEqual(
      m.runningRows().map((e) => [e.kind, e.last]),
      [["empty", true]],
    );
  });

  it("gives the empty row a hairline when idle rows follow it", () => {
    r.data.workspaces = idleWorkspaces(1);
    assert.deepEqual(
      m.runningRows().map((e) => [e.kind, e.last]),
      [
        ["empty", false],
        ["idle", true],
      ],
    );
  });

  it("drops the empty row once something is working", () => {
    r.data.workspaces = [ws("r", { agents: [agent("working")] }), ...idleWorkspaces(1)];
    assert.deepEqual(
      m.runningRows().map((e) => e.kind),
      ["run", "idle"],
    );
  });

  it("flags only the final row as last", () => {
    r.data.workspaces = idleWorkspaces(2);
    assert.deepEqual(
      m.runningRows().map((e) => e.last),
      [false, false, true],
    );
  });

  it("shows Nothing running when the only worker is the selected workspace", () => {
    r.data.workspaces = [ws("sel", { selected: true, agents: [agent("working")] })];
    assert.deepEqual(
      m.runningRows().map((e) => e.kind),
      ["empty"],
    );
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

describe("waitingText", () => {
  it("falls back when the message only echoes the prompt", () => {
    const w = ws("a", { latestMessage: "Please fix it\n", latestPrompt: "Please  fix it" });
    assert.equal(m.waitingText(w), "Waiting for your reply");
  });

  it("falls back with no readable message, else shows it", () => {
    assert.equal(m.waitingText(ws("a", { latestMessage: "/private/tmp/out.txt" })), "Waiting for your reply");
    assert.equal(m.waitingText(ws("a", { latestMessage: "Shall I push?", latestPrompt: "Fix it" })), "Shall I push?");
  });
});

describe("status words", () => {
  it("counts working from its start and idle from its last activity", () => {
    assert.equal(m.statusPhrase(agent("working", { sinceEpoch: 10_000 - 720 })), "Working for 12m");
    assert.equal(m.statusPhrase(agent("idle", { sinceEpoch: 1, lastActivityAt: 10_000 - 60 })), "Idle for 1m");
    assert.equal(m.statusPhrase(agent("ended", { lastActivityAt: 10_000 - 180 })), "Ended 3m ago");
    assert.equal(m.statusPhrase(agent("ended")), "Ended");
    assert.equal(m.statusPhrase(null), "No agent");
  });

  it("rows use the coarse age, the card sentence the finer one", () => {
    const a = agent("needs_input", { sinceEpoch: 10_000 - 5 });
    assert.equal(m.statusLine(a), "needs you <1m");
    assert.equal(m.statusPhrase(a), "Needs you for 5s");
    const long = agent("working", { sinceEpoch: 10_000 - (3 * 3600 + 5 * 60) });
    assert.equal(m.statusLine(long), "working 3h");
    assert.equal(m.statusPhrase(long), "Working for 3h 5m");
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
