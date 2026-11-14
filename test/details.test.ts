// The agents panel's Now and Details tabs (#397): which tab each workspace
// shows, and what the Details cards read. The saved state is seeded before
// the panel's modules load, as they read it at import.

import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { ago, EPOCH, seed } from "./support/snapshot.ts";

const PR_URL = "https://github.com/o/r/pull/12";

const r = seed({
  state: {
    prs: {
      sel: {
        url: PR_URL,
        number: 12,
        status: "open",
        branch: "b",
        title: "Tabs",
        additions: 5,
        deletions: 1,
        checks: [
          { name: "lint", state: "fail", started: ago(120) },
          { name: "lint", state: "pass" },
          { name: "build", state: "pending", queued: ago(30) },
        ],
      },
    },
    names: { c1: { name: "Build the tab", from: "prompt" } },
    subagents: {
      sel: [
        { id: "t1", session: "c1", label: "Done one", startedEpoch: ago(300), endedEpoch: ago(200) },
        { id: "t2", session: "c1", agentId: "x", label: "Live one", startedEpoch: ago(65) },
      ],
    },
    moves: {
      sel: { text: "pick one.", epoch: ago(60), session: "c1", decisions: 1, leans: "1a" },
    },
    published: {
      "https://claude.ai/artifact/p1": {
        url: "https://claude.ai/artifact/p1",
        title: "Plan",
        kind: "page",
        workspace: "sel",
        epoch: ago(100),
      },
      "https://claude.ai/artifact/p2": {
        url: "https://claude.ai/artifact/p2",
        title: "Elsewhere",
        kind: "page",
        workspace: "other",
        epoch: ago(50),
      },
    },
  },
});
const { agent, ws } = await import("./support/fixtures.ts");
const d = await import("../src/agents/details.ts");
const { madeOwn } = await import("../src/agents/made.ts");
const { nodeOf, taps } = await import("./support/renderer.ts");
const { tabSwitch } = await import("../src/agents/views/tabs.ts");

const lead = () =>
  agent("idle", { id: "c1", kind: "claude", name: "Claude", sinceEpoch: ago(60), lastActivityAt: ago(60) });

function select(id: string, extra: Partial<Workspace> = {}): void {
  r.data.workspaces = [
    ws("sel", { selected: id === "sel", latestAt: ago(900), ports: [5173, 8080], agents: [lead()] }),
    ws("other", { selected: id === "other" }),
    ws("plain", { selected: id === "plain", ...extra }),
  ];
}

beforeEach(() => {
  r.data.epoch = EPOCH;
  r.opened.length = 0;
  select("sel");
});

describe("the tab switch", () => {
  it("shows Now until a tab is chosen, and remembers the choice per workspace", () => {
    assert.equal(d.tabOf(), "now");
    d.chooseTab("details");
    assert.equal(d.tabOf(), "details");
    select("other");
    assert.equal(d.tabOf(), "now", "another workspace keeps its own tab");
    select("sel");
    assert.equal(d.tabOf(), "details", "back on the first workspace, its choice holds");
    d.chooseTab("now");
    assert.equal(d.tabOf(), "now");
  });

  it("chooses a tab on a tap", () => {
    const node = nodeOf(tabSwitch());
    assert.ok(node);
    const [now, details] = taps(node);
    assert.ok(now && details);
    const fire = (n: typeof now) => {
      const tap = n.handlers.onTap;
      assert.equal(typeof tap, "function");
      if (typeof tap === "function") tap();
    };
    fire(details);
    assert.equal(d.tabOf(), "details");
    fire(now);
    assert.equal(d.tabOf(), "now");
  });
});

describe("spans and ages", () => {
  it("says a span finely under ten minutes and coarsely past it", () => {
    assert.equal(d.fmtSpan(40.6), "40s");
    assert.equal(d.fmtSpan(70), "1m 10s");
    assert.equal(d.fmtSpan(120), "2m");
    assert.equal(d.fmtSpan(22 * 60 + 5), "22m");
    assert.equal(d.fmtSpan(3600), "1h");
    assert.equal(d.fmtSpan(4320), "1h 12m");
    assert.equal(d.fmtSpan(-1), "");
    assert.equal(d.fmtSpan(Number.NaN), "");
  });
});

describe("sessions", () => {
  it("names every agent, ended ones too, with its kind and last activity", () => {
    r.data.workspaces = [
      ws("sel", {
        selected: true,
        agents: [
          lead(),
          agent("ended", { id: "e1", kind: "codex", lastActivityAt: ago(7200) }),
          agent("working", { id: "w1", kind: "pi", name: "Pi", lastActivityAt: ago(10) }),
        ],
      }),
    ];
    const rows = d.sessionRows();
    assert.deepEqual(
      rows.map((x) => [x.label, x.sub, x.last]),
      [
        ["Pi", "pi, last activity just now", false],
        ["Build the tab", "Claude, last activity 1m ago", false],
        ["codex", "Codex, last activity 2h ago", true],
      ],
    );
  });

  it("leaves out what it does not know", () => {
    assert.equal(d.kindWord(undefined), "");
    assert.equal(d.sessionSub({ id: "z" }), "");
    assert.equal(d.sessionSub({ id: "z", lastActivityAt: ago(300) }), "last activity 5m ago");
  });
});

describe("helpers", () => {
  it("lists running runs first, then finished ones with how long they took", () => {
    assert.deepEqual(
      d.helperRows().map((x) => [x.label, x.figure, x.running, x.last]),
      [
        ["Live one", "running 1m 5s", true, false],
        ["Done one", "took 1m 40s", false, true],
      ],
    );
  });

  it("falls back on when a run ended, then on a plain word", () => {
    assert.equal(d.helperFigure({ running: false, startedEpoch: undefined, endedEpoch: ago(180) }), "ended 3m ago");
    assert.equal(d.helperFigure({ running: false, startedEpoch: undefined, endedEpoch: undefined }), "finished");
    assert.equal(d.helperFigure({ running: true, startedEpoch: undefined, endedEpoch: undefined }), "running");
  });
});

describe("the pull request", () => {
  it("lists every check, passing ones too, each opening the PR's checks page", () => {
    assert.deepEqual(
      d.checkDetails().map((c) => [c.key, c.figure, c.url, c.last]),
      [
        ["c:lint:0", "failed, started 2m ago", PR_URL + "/checks", false],
        ["c:lint:1", "passed", PR_URL + "/checks", false],
        ["c:build:0", "queued 30s", PR_URL + "/checks", true],
      ],
    );
  });

  it("says how long a check has run or queued", () => {
    assert.equal(d.checkFigure({ name: "x", state: "pending", started: ago(75) }), "running 1m 15s");
    assert.equal(d.checkFigure({ name: "x", state: "pending" }), "running");
    assert.equal(d.checkFigure({ name: "x", state: "pass", started: ago(20) }), "passed, started just now");
  });

  it("links a GitHub PR's checks page, and any other link as it is", () => {
    assert.equal(d.checksUrl(PR_URL), PR_URL + "/checks");
    assert.equal(d.checksUrl("https://example.com/pr"), "https://example.com/pr");
    assert.equal(d.checksUrl(undefined), undefined);
  });

  it("says whether it can merge only when the poller says so", () => {
    assert.equal(d.prMergeLine(), "+5 −1");
    assert.equal(d.mergeLine(undefined), "");
    const open = { status: "open" as const, additions: 3, deletions: 2 };
    assert.equal(d.mergeLine({ ...open, mergeable: true }), "Mergeable, no conflicts, +3 −2");
    assert.equal(d.mergeLine({ ...open, conflicts: true, mergeable: true }), "Has merge conflicts, +3 −2");
    assert.equal(d.mergeLine({ status: "merged", additions: 3, deletions: 2 }), "Merged");
    assert.equal(d.mergeLine({ status: "closed" }), "Closed");
    assert.equal(d.mergeLine({ status: "open" }), "");
  });
});

describe("your move", () => {
  it("shows the move the lead agent's turn ended on, with its decisions and leans", () => {
    assert.deepEqual(d.moveDetail(), { text: "pick one.", meta: "1 decision open, leaning 1a", quiet: false });
  });

  it("hides a move a newer prompt has retired", () => {
    r.data.workspaces = [ws("sel", { selected: true, latestAt: ago(10), agents: [lead()] })];
    assert.equal(d.moveDetail(), null);
  });
});

describe("ports and pages", () => {
  it("lists every port, each opening its local page", () => {
    assert.deepEqual(
      d.portRows().map((p) => [p.label, p.url, p.last]),
      [
        [":5173", "http://localhost:5173", false],
        [":8080", "http://localhost:8080", true],
      ],
    );
  });

  it("lists only this workspace's own pages", () => {
    assert.deepEqual(
      madeOwn().map((m) => [m.title, m.last]),
      [["Plan", true]],
    );
  });
});

describe("the note in place of the cards", () => {
  it("says nothing while a card shows", () => {
    assert.equal(d.detailsNote(), "");
  });

  it("says when there is nothing to show, or no workspace", () => {
    select("plain");
    assert.equal(d.detailsNote(), "Nothing more to show for this workspace yet");
    r.data.workspaces = [];
    assert.equal(d.detailsNote(), "No workspace selected");
  });
});
