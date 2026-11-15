// The Details tab's Background work card (#398): the selected workspace's
// saved background tasks as rows, oldest first, each with its kind and age,
// while the core's saved verdict says work runs there.
// The saved state is seeded before the panel's modules load, as they read
// it at import.

import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import type { SavedTask } from "../scripts/state-config.ts";
import { ago, EPOCH, seed } from "./support/snapshot.ts";

const task = (id: string, type: SavedTask["type"], description: string, startedEpoch: number): SavedTask => ({
  id,
  type,
  status: "running",
  description,
  session: "c1",
  startedEpoch,
  seenEpoch: ago(5),
});

const r = seed({
  state: {
    background: {
      sel: [
        task("b2", "monitor", "Watch CI on #12", ago(540)),
        task("b1", "shell", "npm run check", ago(120)),
        task("a8", "monitor", "Watch CI on #13", ago(540)),
        task("s1", "session", "Fix the flaky test", ago(30)),
        task("a9", "subagent", "Review the diff", ago(540)),
        task(
          "w1",
          "monitor",
          "live updates for artifact https://claude.ai/artifact/x (auto-armed on publish)",
          ago(60),
        ),
        task("old", "shell", "npm run dev", ago(7200)),
      ],
      other: [task("o1", "shell", "cargo test", ago(60))],
      // Saved, but the core says nothing runs here: its chat ended, or its age passed.
      none: [task("n1", "shell", "sleep 600", ago(60))],
    },
    running: {
      sel: { agent: "c1", since: ago(540), counts: [{ type: "shell", n: 3 }] },
      other: { agent: "c1", since: ago(60), counts: [{ type: "shell", n: 1 }] },
      bare: { agent: "c1", since: ago(60), counts: [{ type: "shell", n: 1 }] },
    },
  },
});
const { ws } = await import("./support/fixtures.ts");
const bg = await import("../src/agents/background.ts");
const d = await import("../src/agents/details.ts");

function select(id: string): void {
  r.data.workspaces = [
    ws("sel", { selected: id === "sel" }),
    ws("other", { selected: id === "other" }),
    ws("none", { selected: id === "none" }),
    ws("bare", { selected: id === "bare" }),
  ];
}

beforeEach(() => {
  r.data.epoch = EPOCH;
  select("sel");
});

describe("background work", () => {
  it("lists the selected workspace's tasks oldest first, a tie by id, with kind and age", () => {
    assert.deepEqual(
      bg.backgroundRows().map((x) => [x.key, x.label, x.figure, x.last]),
      [
        ["bg:c1:a8", "Watch CI on #13", "monitor, 9m", false],
        ["bg:c1:b2", "Watch CI on #12", "monitor, 9m", false],
        ["bg:c1:b1", "npm run check", "shell, 2m", false],
        ["bg:c1:s1", "Fix the flaky test", "session, <1m", true],
      ],
      "no agent (Helpers lists it), no artifact watch, nothing older than the verdict's earliest work",
    );
    assert.equal(d.cardShows.background(), true);
  });

  it("lists only the selected workspace's own tasks", () => {
    select("other");
    assert.deepEqual(
      bg.backgroundRows().map((x) => x.label),
      ["cargo test"],
    );
  });

  it("hides the card while the core says nothing runs, with none saved, or none selected", () => {
    select("none");
    assert.deepEqual(bg.backgroundRows(), [], "tasks saved, no verdict");
    assert.equal(d.cardShows.background(), false);
    select("bare");
    assert.deepEqual(bg.backgroundRows(), [], "a verdict, no tasks saved");
    r.data.workspaces = [];
    assert.deepEqual(bg.backgroundRows(), []);
  });

  it("names a monitor for what it is and every other kind as its count does", () => {
    assert.equal(bg.kindOf("monitor"), "monitor");
    assert.equal(bg.kindOf("shell"), "shell");
    assert.equal(bg.kindOf("subagent"), "agent");
    assert.equal(bg.kindOf("session"), "session");
    assert.equal(bg.kindOf("other"), "task");
  });

  it("says the kind alone without a clock", () => {
    r.data.epoch = 0;
    assert.equal(bg.taskFigure(task("x", "shell", "x", ago(60))), "shell");
  });
});
