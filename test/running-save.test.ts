// Issue #360: the native core decides whether a card's chat still runs
// background work, and the agents panel says what the card says. The
// core's SaveRunning effect reaches scripts/running-save.ts as JSON (the
// shape native/runner/tests/effects.json pins for the Rust side), which
// writes it in config/state.json's `running` map, and the panel, baked
// from the file, reads its header, rows and dots from that verdict.

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, describe, it } from "node:test";
import { parseRunningSave } from "../scripts/running-save.ts";
import { MAX_COUNTS, type SavedRunning, validateState } from "../scripts/state-config.ts";
import { writeRunningEntries } from "../scripts/state-url.ts";

const dir = mkdtempSync(join(tmpdir(), "running-save-"));
after(() => rmSync(dir, { recursive: true, force: true }));
const fileIn = (name: string, state: unknown): string => {
  const path = join(dir, name);
  writeFileSync(path, JSON.stringify(state));
  return path;
};
const read = (path: string) => validateState(JSON.parse(readFileSync(path, "utf8")));

const NOW = 1_000_000;
const verdict = (agent: string, since: number, counts: SavedRunning["counts"]): SavedRunning => ({
  agent,
  since,
  counts,
});

// The SaveRunning entry the Rust tests hold the bridge's JSON to.
const effects: unknown = JSON.parse(
  readFileSync(join(import.meta.dirname, "..", "native", "runner", "tests", "effects.json"), "utf8"),
);
const native = (Array.isArray(effects) ? effects : []).find((e) => e && typeof e === "object" && "SaveRunning" in e)
  ?.SaveRunning?.running;

describe("the running map's contract", () => {
  it("reads verdicts as persist.rs's running_map does", () => {
    // The same sample as persist.rs's reads_running_verdicts_as_validate_state_does.
    const shell = [{ type: "shell", n: 1 }];
    const state = validateState({
      running: {
        w1: {
          agent: "s1",
          since: 100,
          counts: [
            { type: "shell", n: 2 },
            { type: "a new kind", n: 1 },
          ],
          extra: 1,
        },
        "no counts": { agent: "s1", since: 100, counts: [] },
        zero: { agent: "s1", since: 100, counts: [{ type: "shell", n: 0 }] },
        "too many": { agent: "s1", since: 100, counts: [{ type: "shell", n: 21 }] },
        half: { agent: "s1", since: 100, counts: [{ type: "shell", n: 1.5 }] },
        "no type": { agent: "s1", since: 100, counts: [{ type: 3, n: 1 }] },
        "bad since": { agent: "s1", since: -1, counts: shell },
        "no agent": { agent: "", since: 100, counts: shell },
        junk: "x",
        ["__proto__"]: { agent: "s1", since: 100, counts: shell },
      },
    });
    assert.deepEqual(state.running, {
      w1: verdict("s1", 100, [
        { type: "shell", n: 2 },
        { type: "other", n: 1 },
      ]),
    });
  });

  it("keeps one count per task type at most, and leaves the map out while empty", () => {
    const counts = Array.from({ length: MAX_COUNTS + 1 }, () => ({ type: "shell", n: 1 }));
    assert.equal(validateState({ running: { w: { agent: "s", since: 1, counts } } }).running, undefined);
    assert.equal("running" in validateState({}), false);
  });
});

describe("parseRunningSave", () => {
  it("reads the native effect's JSON, nulls and whole floats included", () => {
    assert.ok(native, "effects.json holds a SaveRunning entry");
    const input = parseRunningSave(JSON.stringify(native));
    assert.ok(input.ok);
    assert.deepEqual(input.remove, ["W2"]);
    assert.equal(input.skipped, 0);
    assert.deepEqual(input.set, {
      W1: verdict("s1", 1791229800, [
        { type: "shell", n: 1 },
        { type: "subagent", n: 2 },
      ]),
    });
  });

  it("skips an entry the contract refuses rather than deleting what the file holds", () => {
    const good = verdict("s", 5, [{ type: "shell", n: 1 }]);
    const input = parseRunningSave(JSON.stringify({ a: { agent: "s" }, b: good }));
    assert.ok(input.ok);
    assert.deepEqual(input.set, { b: good });
    assert.deepEqual(input.remove, []);
    assert.equal(input.skipped, 1);
  });

  it("refuses what is not a JSON map", () => {
    for (const bad of [undefined, "", "{", "[]", "null", '"x"']) {
      assert.equal(parseRunningSave(bad).ok, false, String(bad));
    }
  });
});

describe("writeRunningEntries", () => {
  it("sets and deletes only the entries given, keeps the rest, and says when nothing changed", () => {
    const one = verdict("s", 5, [{ type: "shell", n: 1 }]);
    const two = verdict("s", 5, [{ type: "shell", n: 2 }]);
    const path = fileIn("entries.json", { running: { a: one, b: one }, dismissed: { x: { s: 1 } } });
    assert.deepEqual(writeRunningEntries(path, { a: two, c: one }, ["b"]), { ok: true, changed: true });
    const state = read(path);
    assert.deepEqual(state.running, { a: two, c: one });
    assert.deepEqual(Object.keys(state.dismissed), ["x"], "other maps stay");
    assert.deepEqual(writeRunningEntries(path, { a: two }, []), { ok: true, changed: false });
    writeRunningEntries(path, {}, ["a", "c"]);
    assert.equal("running" in read(path), false, "an emptied map is left out");
  });
});

// The agents panel, baked from a file the core wrote: W1's chat c1 is
// idle with a shell and an agent running since four minutes ago.
const panelFile = fileIn("panel.json", {});
writeRunningEntries(
  panelFile,
  {
    W1: verdict("c1", NOW - 240, [
      { type: "shell", n: 1 },
      { type: "subagent", n: 1 },
    ]),
  },
  [],
);
(globalThis as Record<string, unknown>).__STATE__ = read(panelFile);

const { installRenderer } = await import("./support/renderer.ts");
const r = installRenderer();
const { agent, ws } = await import("./support/fixtures.ts");
const model = await import("../src/agents/model.ts");
const { T } = await import("../src/agents/theme.ts");
const { runningText, taskWord } = await import("../src/shared/words.ts");

describe("the agents panel reads the core's verdict (issue #360)", () => {
  beforeEach(() => {
    r.data.epoch = NOW;
  });

  const scene = (status: AgentStatus, id = "c1") =>
    ws("W1", { selected: true, agents: [agent(status, { id, sinceEpoch: NOW - 60, lastActivityAt: NOW - 60 })] });

  it("says Running with the card's words and colours while the chat is idle", () => {
    const w = scene("idle");
    const a = w.agents?.[0] ?? null;
    assert.equal(model.headStatus(a, w), "Running 4m · 1 shell, 1 agent");
    assert.equal(model.statusLine(a, w), "running 4m");
    assert.equal(model.dotFor(a, w), T.blue);
    assert.equal(model.haloFor(a, w), T.blueHalo);
    assert.equal(model.statusColor(a, w), T.blueText);
    assert.equal(model.hollowDot(a, w), false);
  });

  it("leaves a working chat Working and an idle one the verdict is not about Idle", () => {
    const working = scene("working");
    assert.equal(model.headStatus(working.agents?.[0] ?? null, working), "Working 1m");
    const other = scene("idle", "c2");
    const a = other.agents?.[0] ?? null;
    assert.equal(model.headStatus(a, other), "Idle 1m");
    assert.equal(model.hollowDot(a, other), true);
    const elsewhere = ws("W2", { agents: [agent("idle", { id: "c1", lastActivityAt: NOW - 60 })] });
    assert.equal(model.headStatus(elsewhere.agents?.[0] ?? null, elsewhere), "Idle 1m");
  });

  it("names each kind as the card does, singular and plural", () => {
    assert.equal(
      runningText([
        { type: "session", n: 2 },
        { type: "monitor", n: 1 },
        { type: "cloud session", n: 3 },
        { type: "MCP task", n: 1 },
        { type: "other", n: 2 },
      ]),
      "· 2 sessions, 1 shell, 3 cloud sessions, 1 MCP task, 2 tasks",
    );
    assert.equal(taskWord("workflow", 1) + " " + taskWord("teammate", 2), "workflow teammates");
    assert.equal(runningText([]), "");
  });
});
