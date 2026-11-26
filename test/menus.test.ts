// The agents panel's pointing hand and its agent rows' right-click menu,
// on the built panel: every tap target shows a hand, and an agent row goes
// to that agent or copies the workspace's branch.

import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { ago, seed } from "./support/snapshot.ts";

const url = (n: number): string => `https://github.com/o/r/pull/${n}`;

const r = seed({
  state: {
    prs: { here: { url: url(12), number: 12, status: "open", branch: "menus", title: "Menus" } },
    published: {
      "https://claude.ai/artifact/a1": {
        url: "https://claude.ai/artifact/a1",
        title: "Menu plan",
        kind: "doc",
        workspace: "here",
        epoch: ago(3600),
      },
    },
  },
});
const { menuOf, modValue, nodeOf, taps } = await import("./support/renderer.ts");
const { agent, ws } = await import("./support/fixtures.ts");
await import("../src/agents/index.ts");
const { chooseTab } = await import("../src/agents/details.ts");
const { agentMenu } = await import("../src/agents/team.ts");

const lead = agent("working", { name: "Claude", surfaceId: "s-lead", lastActivityAt: ago(20) });
const second = agent("idle", {
  name: "Claude",
  title: "Check the menus",
  surfaceId: "s-two",
  lastActivityAt: ago(240),
});

function panel() {
  const root = r.roots.at(-1);
  assert.ok(root, "the agents panel registered no root");
  const node = nodeOf(root());
  assert.ok(node, "the root is not a view the fake renderer built");
  return node;
}

const agentRow = (label: string) =>
  taps(panel()).find((n) => menuOf(n).some((i) => i.label === "Go to this agent") && JSON.stringify(n).includes(label));

beforeEach(() => {
  r.calls.length = 0;
  r.copied.length = 0;
  r.data.selectedId = "here";
  r.data.workspaces = [
    ws("here", {
      selected: true,
      branch: "menus",
      ports: [5173],
      agents: [lead, second],
    }),
  ];
});

describe("the pointing hand", () => {
  it("shows over every tap target on both tabs", () => {
    for (const tab of ["now", "details"] as const) {
      chooseTab(tab);
      const targets = taps(panel());
      assert.ok(targets.length > 3, `the ${tab} tab has its tap targets`);
      for (const n of targets) assert.equal(modValue(n, "cursor"), "pointer", `a ${n.kind} on the ${tab} tab`);
    }
    chooseTab("now");
  });
});

describe("a right-click on an agent row", () => {
  it("goes to that agent or copies the workspace's branch", () => {
    const row = agentRow("Check the menus");
    assert.deepEqual(
      menuOf(row).map((i) => i.label),
      ["Go to this agent", "Copy branch name"],
    );
    for (const i of menuOf(row)) i.action();
    assert.deepEqual(r.calls, [
      { method: "workspace.select", params: { workspace_id: "here" } },
      { method: "surface.focus", params: { surface_id: "s-two", workspace_id: "here" } },
    ]);
    assert.deepEqual(r.copied, ["menus"]);
  });

  it("offers no branch to copy when the workspace has none", () => {
    assert.deepEqual(
      agentMenu(second, ws("w")).map((i) => (i === "divider" ? i : i.label)),
      ["Go to this agent"],
    );
  });
});
