// Issue #300: for one PR, the cockpit card, the agents panel's Pull
// requests row and This workspace's status chip say the same state in the
// same health. The screenshot's case comes first: the selected workspace's
// PR, out of draft with its checks passed and GitHub's merge verdict saved,
// also listed among Jon's own PRs and opened by this chat (prOrigins), so
// the row could come from either copy. __STATE__ is set before the renderer
// import, as in prs-saved.test.ts, since the saved PRs are read once at load.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

const pass = [{ name: "build", state: "pass" }];
const url = (n: number): string => "https://github.com/o/r/pull/" + n;
const open = (n: number) => ({ number: n, url: url(n), status: "open", branch: "feat", checks: pass });

const prs: Record<string, Record<string, unknown>> = {
  ready: { ...open(296), mergeable: true },
  draft: { ...open(2), draft: true, mergeable: true },
  draftRunning: { ...open(3), draft: true, checks: [{ name: "test", state: "pending" }] },
  failing: { ...open(4), mergeable: true, checks: [{ name: "build", state: "fail" }] },
  conflicts: { ...open(5), conflicts: true },
  merged: { ...open(6), status: "merged", mergeable: true },
  // Out of draft, checks passed, before GitHub's merge verdict was saved:
  // what config/state.json held for #296 while the screenshot was taken.
  noVerdict: { ...open(7) },
};

// Each open PR is also one of Jon's own, opened by its workspace's chat.
const openIds = Object.keys(prs).filter((id) => prs[id]?.status === "open");
const ownPrs = Object.fromEntries(
  openIds.map((id) => {
    const pr = prs[id] ?? {};
    const own = { number: pr.number, url: pr.url, status: "open", branch: "feat", title: "Own " + id, repo: "/r" };
    return [pr.url, pr.draft ? { ...own, draft: true } : own];
  }),
);
const prOrigins = Object.fromEntries(
  Object.entries(prs).map(([id, pr]) => [pr.url, { url: pr.url, number: pr.number, workspace: id, epoch: 1 }]),
);

(globalThis as Record<string, unknown>).__STATE__ = {
  dismissed: {},
  projectOverride: {},
  projects: {},
  prs,
  ownPrs,
  prOrigins,
  ui: {},
};

const { installRenderer } = await import("./support/renderer.ts");
const r = installRenderer();
const { agent, ws } = await import("./support/fixtures.ts");
const chips = await import("../src/cockpit/card-chips.ts");
const list = await import("../src/agents/pr-list.ts");
const model = await import("../src/agents/model.ts");

interface Said {
  state: string;
  health: string;
}

// The three places, with `id` the selected workspace and its agent working,
// so the card keeps its state words (a finished one's status would say
// Ready to merge instead, issue #299).
function saidFor(id: string): { card: Said; row: Said; here: Said } {
  r.data.workspaces = [ws(id, { branch: "feat", selected: true, agents: [agent("working")] })];
  r.data.epoch++;
  const chip = chips.chipsFor(r.data.workspaces[0], false).find((c) => c.id === "pr");
  const card = chip && "health" in chip ? { state: chip.state, health: chip.health } : undefined;
  const entry = list.prs().find((e) => e.pr.url === prs[id]?.url);
  const row = entry ? { state: list.prChipText(entry), health: list.prChipHealth(entry) } : undefined;
  const pr = model.currentPr();
  const here = pr ? { state: pr.state, health: pr.health } : undefined;
  assert.ok(card && row && here, `${id}: every place shows the PR`);
  return { card, row, here };
}

describe("one PR's state, card and agents panel alike (issue #300)", () => {
  const cases: [string, Said][] = [
    ["ready", { state: "ready", health: "ready" }],
    ["draft", { state: "draft", health: "quiet" }],
    ["draftRunning", { state: "draft · running", health: "running" }],
    ["failing", { state: "1 failing", health: "failing" }],
    ["conflicts", { state: "conflicts", health: "conflicts" }],
    ["merged", { state: "merged", health: "quiet" }],
    ["noVerdict", { state: "open", health: "quiet" }],
  ];
  for (const [id, want] of cases) {
    it(`says ${want.state} in all three places for ${id}`, () => {
      const said = saidFor(id);
      assert.deepEqual(said.card, want, "the card");
      assert.deepEqual(said.row, want, "the Pull requests row");
      assert.deepEqual(said.here, want, "This workspace");
    });
  }

  it("lists the screenshot's PR once, as this chat's, from the workspace's saved copy", () => {
    saidFor("ready");
    const rows = list.prs().filter((e) => e.pr.number === 296);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.session?.name, "This chat");
    assert.equal(rows[0]?.summary?.state, "ready");
  });
});
