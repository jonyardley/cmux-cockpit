// What a cockpit card says (issues #47 and #48): the status line with its
// time and helper count, the agent's message, the progress fraction, and the
// chip list.

import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { installRenderer } from "./support/renderer.ts";

const r = installRenderer();
const { agent, ws } = await import("./support/fixtures.ts");
const status = await import("../src/cockpit/status.ts");
const model = await import("../src/cockpit/model.ts");
const { showsChipsRow } = await import("../src/cockpit/chips.ts");
const { liveRunCount } = await import("../src/shared/subagents.ts");

beforeEach(() => {
  r.data.epoch += 100;
});

describe("statusLine", () => {
  it("says how long the status has held", () => {
    const w = ws("x", { agents: [agent("working", { sinceEpoch: r.data.epoch - 14 * 60 })] });
    assert.equal(status.statusLine(w), "Working 14m");
  });

  it("reads the most active agent's time", () => {
    const w = ws("x", {
      agents: [agent("idle", { sinceEpoch: r.data.epoch - 7200 }), agent("working", { sinceEpoch: r.data.epoch - 30 })],
    });
    assert.equal(status.statusLine(w), "Working <1m");
  });

  it("leaves the time off when nothing says when the status began", () => {
    assert.equal(status.statusLine(ws("x", { agents: [agent("idle")] })), "Idle");
  });

  it("never reads last activity or latestAt as the status start", () => {
    const w = ws("x", {
      latestAt: r.data.epoch - 600,
      agents: [agent("working", { lastActivityAt: r.data.epoch - 5 })],
    });
    assert.equal(status.statusLine(w), "Working");
  });

  it("gives no time for a workspace with no agent", () => {
    assert.equal(status.statusLine(ws("x", { latestAt: r.data.epoch - 600 })), "No agent");
    assert.equal(status.statusLine(undefined), "No agent");
  });
});

describe("cardDetail", () => {
  it("shows the agent's latest message", () => {
    const w = ws("x", { latestMessage: "Running the recovery tests", latestPrompt: "go" });
    assert.equal(status.cardDetail(w), "Running the recovery tests");
  });

  it("hides a message that only echoes the prompt, and never shows the prompt", () => {
    assert.equal(status.cardDetail(ws("x", { latestMessage: "go on then", latestPrompt: "go on then" })), "");
    assert.equal(status.cardDetail(ws("x", { latestPrompt: "go on then" })), "");
  });

  it("falls back on the workspace description", () => {
    assert.equal(status.cardDetail(ws("x", { description: "Fixing the lanes" })), "Fixing the lanes");
  });

  it("cuts a long message to two lines' worth", () => {
    const long = "word ".repeat(80);
    const out = status.cardDetail(ws("x", { latestMessage: long }));
    assert.equal(out.length, status.DETAIL_MAX);
    assert.ok(out.endsWith("…"));
  });
});

describe("helpers", () => {
  it("counts running cmux children across the workspace's agents", () => {
    const w = ws("x", {
      agents: [
        agent("working", {
          children: [{ id: "a", running: true }, { id: "b", running: false, endedEpoch: 5 }, { id: "c" }],
        }),
        agent("working", { children: [{ id: "d", running: true }] }),
      ],
    });
    assert.equal(liveRunCount(w), 3);
    assert.equal(status.helperText(w), "· 3 helpers");
  });

  it("says one helper in the singular", () => {
    const w = ws("x", { agents: [agent("working", { children: [{ id: "a", running: true }] })] });
    assert.equal(status.helperText(w), "· 1 helper");
  });

  it("counts nothing under an ended session, whatever the run says", () => {
    const w = ws("x", { agents: [agent("ended", { children: [{ id: "a", running: true }] })] });
    assert.equal(liveRunCount(w), 0);
    assert.equal(status.helperText(w), "");
  });

  it("is empty with no workspace or no runs", () => {
    assert.equal(liveRunCount(undefined), 0);
    assert.equal(status.helperText(ws("x", { agents: [agent("working")] })), "");
  });

  it("skips holes in a children array", () => {
    // The cast holds because the count only reads a child through a falsy check.
    const holes: SubagentRun[] = [null as unknown as SubagentRun, { id: "a", running: true }];
    assert.equal(liveRunCount(ws("x", { agents: [agent("working", { children: holes })] })), 1);
  });
});

describe("progressFraction", () => {
  it("is the progress value, held between 0 and 1", () => {
    assert.equal(status.progressFraction(ws("x", { progress: { value: 0.62 } })), 0.62);
    assert.equal(status.progressFraction(ws("x", { progress: { value: 1.4 } })), 1);
    assert.equal(status.progressFraction(ws("x", { progress: { value: -1 } })), 0);
  });

  it("is null when no value is sent", () => {
    assert.equal(status.progressFraction(ws("x")), null);
    assert.equal(status.progressFraction(ws("x", { progress: null })), null);
    assert.equal(status.progressFraction(ws("x", { progress: { label: "Building" } })), null);
    assert.equal(status.progressFraction(ws("x", { progress: { value: Number.NaN } })), null);
    assert.equal(status.progressFraction(undefined), null);
  });
});

describe("chipsFor", () => {
  it("shows the PR, then the branch with its dirty flag", () => {
    const chips = model.chipsFor(
      ws("x", { pr: { number: 7, status: "open", url: "https://x/7" }, branch: "feat", dirty: true }),
      true,
    );
    assert.deepEqual(
      chips.map((c) => [c.id, c.text, c.dirty ?? false]),
      [
        ["pr", "#7", false],
        ["br", "feat", true],
      ],
    );
    assert.equal(chips[0]?.url, "https://x/7");
    assert.equal(model.chipsFor(ws("y", { branch: "feat" }), false).length, 0);
    assert.equal(model.chipsFor(ws("y", { branch: "feat" }), true)[0]?.dirty, false);
  });

  it("adds a ports chip that opens the first port on localhost", () => {
    const [port] = model.chipsFor(ws("x", { ports: [5173] }), true);
    assert.deepEqual(port, { id: "port", text: ":5173 ↗", url: "http://localhost:5173" });
  });

  it("shows the first port and how many more", () => {
    const [port] = model.chipsFor(ws("x", { ports: [5173, 3000, 5173, 8080] }), true);
    assert.equal(port?.text, ":5173 +2 ↗");
    assert.equal(port?.url, "http://localhost:5173");
  });

  it("skips ports that are not real port numbers", () => {
    assert.deepEqual(model.chipsFor(ws("x", { ports: [0, 70000, 1.5] }), true), []);
    assert.deepEqual(model.chipsFor(ws("x", { ports: [] }), true), []);
    assert.deepEqual(model.chipsFor(undefined, true), []);
  });

  it("orders the chips PR, branch, ports", () => {
    const w = ws("x", { pr: { number: 7 }, branch: "main", ports: [5173] });
    assert.deepEqual(
      model.chipsFor(w, true).map((c) => c.id),
      ["pr", "br", "port"],
    );
  });
});

describe("showsChipsRow (issue #79)", () => {
  const shows = (w: Workspace | undefined, withBranch: boolean, withPr: boolean) =>
    showsChipsRow(model.chipsFor(w, withBranch), w, withPr);

  it("has no row with no chips", () => {
    assert.equal(shows(ws("x"), true, true), false);
    assert.equal(shows(ws("x"), true, false), false);
    assert.equal(shows(undefined, true, false), false);
  });

  it("drops the row on a full card whose only chip is the PR, which has a line of its own", () => {
    const w = ws("x", { pr: { number: 7, status: "open" } });
    assert.equal(shows(w, true, true), true);
    assert.equal(shows(w, true, false), false);
  });

  it("keeps the row for a branch or ports chip", () => {
    assert.equal(shows(ws("x", { pr: { number: 7 }, branch: "feat" }), true, false), true);
    assert.equal(shows(ws("x", { ports: [5173] }), true, false), true);
  });

  it("leaves the branch out when the card does", () => {
    assert.equal(shows(ws("x", { branch: "feat" }), false, false), false);
  });

  it("agrees with hasChipsRow when the PR chip is in the row", () => {
    for (const w of [ws("a"), ws("b", { pr: { number: 7 } }), ws("c", { branch: "feat" }), ws("d", { ports: [80] })]) {
      assert.equal(shows(w, true, true), model.hasChipsRow(w, true));
    }
  });
});
