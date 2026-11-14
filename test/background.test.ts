// The Details tab's Background work card (#398): the selected workspace's
// saved background tasks as rows, oldest first, each with its kind and age.
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
        task("a9", "subagent", "  ", ago(540)),
      ],
      other: [task("o1", "shell", "cargo test", ago(60))],
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
        ["bg:c1:a9", "Background task", "agent, 9m", false],
        ["bg:c1:b2", "Watch CI on #12", "monitor, 9m", false],
        ["bg:c1:b1", "npm run check", "shell, 2m", true],
      ],
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

  it("hides the card for a workspace with none saved, or none selected", () => {
    select("none");
    assert.deepEqual(bg.backgroundRows(), []);
    assert.equal(d.cardShows.background(), false);
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
