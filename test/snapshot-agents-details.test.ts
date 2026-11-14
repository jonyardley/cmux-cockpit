// Scene: the agents panel's Details tab (#397) for a selected workspace
// whose chat ended its turn on a move with two decisions, beside a codex
// session and one that has ended. A helper still runs and two have
// finished; the PR has a failing, a running, a queued and a passing check
// and can merge; four ports are open and the chat published two pages.
// Fixture data only; see test/support/snapshot.ts.

import { it } from "node:test";
import { ago, seed, snapshotScene } from "./support/snapshot.ts";

const url = "https://github.com/o/r/pull/12";
const page = (id: string, title: string, epoch: number) => ({
  url: "https://claude.ai/artifact/" + id,
  title,
  kind: "page" as const,
  workspace: "here",
  epoch,
});

const r = seed({
  state: {
    prs: {
      here: {
        url,
        number: 12,
        status: "open",
        branch: "details-tab",
        title: "Now and Details tabs in the agents panel",
        mergeable: true,
        additions: 412,
        deletions: 38,
        checks: [
          { name: "lint", state: "fail", started: ago(840) },
          { name: "build", state: "pending", started: ago(190) },
          { name: "mac", state: "pending", queued: ago(75) },
          { name: "secrets", state: "pass", started: ago(3000) },
        ],
      },
    },
    names: { c1: { name: "Build the Details tab", from: "prompt" } },
    subagents: {
      here: [
        { id: "t1", session: "c1", label: "Inventory the panel data", startedEpoch: ago(2400), endedEpoch: ago(2280) },
        { id: "t2", session: "c1", label: "Lint sweep", startedEpoch: ago(1300), endedEpoch: ago(1260) },
        { id: "t3", session: "c1", agentId: "x3", label: "Review the diff", startedEpoch: ago(70) },
      ],
    },
    moves: {
      here: {
        text: "pick the tab look and the card order, then I build the cards.",
        epoch: ago(60),
        session: "c1",
        decisions: 2,
        leans: "1a 2b",
      },
    },
    published: Object.fromEntries(
      [page("p1", "Details tab plan", ago(5400)), page("p2", "Tab switch mock-up", ago(900))].map((e) => [e.url, e]),
    ),
    poll: { okEpoch: ago(60) },
  },
});
const { agent, ws } = await import("./support/fixtures.ts");
await import("../src/agents/index.ts");
const { chooseTab } = await import("../src/agents/details.ts");
const { T } = await import("../src/agents/theme.ts");

it("the agents panel's Details tab", () => {
  r.data.selectedId = "here";
  r.data.workspaces = [
    ws("here", {
      title: "Details tab",
      selected: true,
      directory: "/Users/jon/dev/app-one",
      branch: "details-tab",
      ports: [5173, 6006, 8080, 3000],
      latestAt: ago(900),
      agents: [
        agent("idle", { id: "c1", kind: "claude", name: "Claude", sinceEpoch: ago(60), lastActivityAt: ago(60) }),
        agent("idle", { id: "x1", kind: "codex", name: "Codex", sinceEpoch: ago(600), lastActivityAt: ago(600) }),
        agent("ended", { id: "c0", kind: "claude", name: "Claude", title: "Plan the tab", lastActivityAt: ago(7200) }),
      ],
    }),
  ];
  chooseTab("details");
  snapshotScene("agents-details", r, T, "agents");
});
