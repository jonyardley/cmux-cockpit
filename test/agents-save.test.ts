// Issue #429: the native core decides how each agent shows and why it
// waits on Jon. Its SaveAgents effect reaches scripts/agents-save.ts as
// JSON (the shape native/runner/tests/effects.json pins for the Rust
// side), which writes it in config/state.json's `agents` map for the
// agents panel to read.

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { parseAgentsSave } from "../scripts/agents-save.ts";
import { MAX_AGENTS, validateState } from "../scripts/state-config.ts";
import { writeAgentsEntries } from "../scripts/state-url.ts";

const dir = mkdtempSync(join(tmpdir(), "agents-save-"));
after(() => rmSync(dir, { recursive: true, force: true }));
const fileIn = (name: string, state: unknown): string => {
  const path = join(dir, name);
  writeFileSync(path, JSON.stringify(state));
  return path;
};
const read = (path: string) => validateState(JSON.parse(readFileSync(path, "utf8")));

const effects: unknown = JSON.parse(
  readFileSync(join(import.meta.dirname, "..", "native", "runner", "tests", "effects.json"), "utf8"),
);
const native = (Array.isArray(effects) ? effects : []).find((e) => e && typeof e === "object" && "SaveAgents" in e)
  ?.SaveAgents?.agents;

describe("the agents map's contract", () => {
  it("reads lists as persist.rs's agents_map does", () => {
    // The same sample as persist.rs's reads_shown_agents_as_validate_state_does.
    const state = validateState({
      agents: {
        w1: [
          { id: "s1", status: "needs_input", since: 100.5, why: "ask", reason: "allow?", extra: 1 },
          { id: "s2", status: "working", since: 0 },
        ],
        w2: [{ id: "stand-in", status: "needs_input", since: 5, why: "ci" }],
        "why when idle": [{ id: "s1", status: "idle", since: 1, why: "turn" }],
        "reason on a turn": [{ id: "s1", status: "needs_input", since: 1, why: "turn", reason: "x" }],
        "ask with no reason": [{ id: "s1", status: "needs_input", since: 1, why: "ask" }],
        "unknown status": [{ id: "s1", status: "busy", since: 1 }],
        "unknown why": [{ id: "s1", status: "needs_input", since: 1, why: "nap" }],
        "one bad": [
          { id: "s1", status: "idle", since: 1 },
          { id: "", status: "idle", since: 1 },
        ],
        empty: [],
        ["__proto__"]: [{ id: "s1", status: "idle", since: 1 }],
      },
    });
    assert.deepEqual(state.agents, {
      w1: [
        { id: "s1", status: "needs_input", since: 100.5, why: "ask", reason: "allow?" },
        { id: "s2", status: "working", since: 0 },
      ],
      w2: [{ id: "stand-in", status: "needs_input", since: 5, why: "ci" }],
    });
    const many = Array.from({ length: MAX_AGENTS + 1 }, () => ({ id: "s", status: "idle", since: 1 }));
    assert.equal("agents" in validateState({ agents: { w: many } }), false, "too many");
    assert.equal("agents" in validateState({}), false, "left out while empty");
  });
});

describe("parseAgentsSave", () => {
  it("reads the native effect's JSON, nulls and whole floats included", () => {
    assert.ok(native, "effects.json holds a SaveAgents entry");
    const input = parseAgentsSave(JSON.stringify(native));
    assert.ok(input.ok);
    assert.deepEqual(input.remove, ["W2"]);
    assert.equal(input.skipped, 0);
    assert.deepEqual(input.set, {
      W1: [
        { id: "s1", status: "needs_input", since: 1791229800, why: "ask", reason: "allow git push?" },
        { id: "s2", status: "working", since: 1791229200 },
      ],
    });
  });

  it("skips a list the contract refuses rather than deleting what the file holds", () => {
    const good = [{ id: "s", status: "idle", since: 5 }];
    const input = parseAgentsSave(JSON.stringify({ a: [{ id: "s", status: "busy", since: 5 }], b: good }));
    assert.ok(input.ok);
    assert.deepEqual(input.set, { b: good });
    assert.deepEqual(input.remove, []);
    assert.equal(input.skipped, 1);
  });

  it("refuses what is not a JSON map", () => {
    for (const bad of [undefined, "", "{", "[]", "null", '"x"']) {
      assert.equal(parseAgentsSave(bad).ok, false, String(bad));
    }
  });
});

describe("writeAgentsEntries", () => {
  it("sets and deletes only the entries given, keeps the rest, and says when nothing changed", () => {
    const one = [{ id: "s", status: "idle" as const, since: 5 }];
    const two = [{ id: "s", status: "working" as const, since: 6 }];
    const path = fileIn("entries.json", { agents: { a: one, b: one }, dismissed: { x: { s: 1 } } });
    assert.deepEqual(writeAgentsEntries(path, { a: two, c: one }, ["b"]), { ok: true, changed: true });
    const state = read(path);
    assert.deepEqual(state.agents, { a: two, c: one });
    assert.deepEqual(Object.keys(state.dismissed), ["x"], "other maps stay");
    assert.deepEqual(writeAgentsEntries(path, { a: two }, []), { ok: true, changed: false });
    writeAgentsEntries(path, {}, ["a", "c"]);
    assert.equal("agents" in read(path), false, "an emptied map is left out");
  });
});
