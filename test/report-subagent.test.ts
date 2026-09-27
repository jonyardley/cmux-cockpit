// The pure parts of the subagent reporter hook (#6): folding one Claude Code
// hook event into a workspace's runs, pruning stale ones, and deciding
// whether that counts as a visible change. The lockfile, the spawn and the
// stdin/env plumbing in main() are not covered.

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyEvent,
  BUILD_LOCK_STALE_MS,
  BUILD_TIMEOUT_MS,
  buildUntilStable,
  COALESCE_MS,
  processEvent,
  prune,
  visibleChange,
} from "../scripts/hooks/report-subagent.ts";
import { MAX_LABEL, type State } from "../scripts/state-config.ts";

type SubagentMap = State["subagents"];

const EMPTY: SubagentMap = {};

const preToolUse = (session: string, toolUseId: string, description?: string, subagentType?: string) => ({
  hook_event_name: "PreToolUse",
  tool_name: "Agent",
  session_id: session,
  tool_use_id: toolUseId,
  tool_input: { description, subagent_type: subagentType },
});

const subagentStart = (session: string, agentId: string, agentType?: string) => ({
  hook_event_name: "SubagentStart",
  session_id: session,
  agent_id: agentId,
  agent_type: agentType,
});

const subagentStop = (agentId: string) => ({
  hook_event_name: "SubagentStop",
  agent_id: agentId,
});

test("PreToolUse on Agent appends a run keyed by the call, labelled from the description", () => {
  const map = applyEvent(EMPTY, "w1", preToolUse("s1", "toolu_1", "  Review   the\tdiff  "), 100);
  assert.deepEqual(map.w1, [{ id: "toolu_1", session: "s1", label: "Review the diff", startedEpoch: 100 }]);
});

test('falls back to subagent_type, then "subagent", when the description is unusable', () => {
  const byType = applyEvent(EMPTY, "w1", preToolUse("s1", "toolu_1", undefined, "code-reviewer"), 100);
  assert.equal(byType.w1?.[0]?.label, "code-reviewer");

  const bare = applyEvent(EMPTY, "w1", preToolUse("s1", "toolu_1", "   ", ""), 100);
  assert.equal(bare.w1?.[0]?.label, "subagent");
});

test("cuts a long description to MAX_LABEL and strips control characters", () => {
  const long = "x".repeat(MAX_LABEL + 40);
  const map = applyEvent(EMPTY, "w1", preToolUse("s1", "toolu_1", `a\u0000b\nc${long}`), 100);
  const label = map.w1?.[0]?.label ?? "";
  assert.equal(label.length, MAX_LABEL);
  assert.ok(!label.includes("\u0000"));
});

test("ignores PreToolUse for any tool other than Agent", () => {
  const event = { ...preToolUse("s1", "toolu_1"), tool_name: "Bash" };
  assert.deepEqual(applyEvent(EMPTY, "w1", event, 100), EMPTY);
});

test("SubagentStart pairs the oldest unpaired run in that session", () => {
  let map = applyEvent(EMPTY, "w1", preToolUse("s1", "toolu_1", "First"), 100);
  map = applyEvent(map, "w1", preToolUse("s1", "toolu_2", "Second"), 101);
  map = applyEvent(map, "w1", subagentStart("s1", "agent_1"), 102);
  assert.deepEqual(
    map.w1?.map((r) => [r.id, r.agentId]),
    [
      ["toolu_1", "agent_1"],
      ["toolu_2", undefined],
    ],
  );
});

test("two parallel spawns in one session pair up FIFO, oldest call to oldest start", () => {
  let map = applyEvent(EMPTY, "w1", preToolUse("s1", "toolu_1", "First"), 100);
  map = applyEvent(map, "w1", preToolUse("s1", "toolu_2", "Second"), 101);
  map = applyEvent(map, "w1", subagentStart("s1", "agent_a"), 102);
  map = applyEvent(map, "w1", subagentStart("s1", "agent_b"), 103);
  assert.deepEqual(
    map.w1?.map((r) => [r.id, r.agentId]),
    [
      ["toolu_1", "agent_a"],
      ["toolu_2", "agent_b"],
    ],
  );
});

test("SubagentStart with no matching PreToolUse appends a run labelled from agent_type", () => {
  const map = applyEvent(EMPTY, "w1", subagentStart("s1", "agent_1", "code-reviewer"), 100);
  assert.deepEqual(map.w1, [
    {
      id: "agent_1",
      session: "s1",
      agentId: "agent_1",
      type: "code-reviewer",
      label: "code-reviewer",
      startedEpoch: 100,
    },
  ]);
});

test("PreToolUse ignores a duplicate delivery of the same call", () => {
  let map = applyEvent(EMPTY, "w1", preToolUse("s1", "toolu_1", "First"), 100);
  map = applyEvent(map, "w1", preToolUse("s1", "toolu_1", "First"), 101);
  assert.equal(map.w1?.length, 1);
});

test("SubagentStart prefers the oldest unpaired run whose saved type matches agent_type", () => {
  let map = applyEvent(EMPTY, "w1", preToolUse("s1", "toolu_1", "First", "explorer"), 100);
  map = applyEvent(map, "w1", preToolUse("s1", "toolu_2", "Second", "code-reviewer"), 101);
  // toolu_1 is older, but only toolu_2 matches this event's agent_type.
  map = applyEvent(map, "w1", subagentStart("s1", "agent_1", "code-reviewer"), 102);
  assert.deepEqual(
    map.w1?.map((r) => [r.id, r.agentId]),
    [
      ["toolu_1", undefined],
      ["toolu_2", "agent_1"],
    ],
  );
});

test("SubagentStart falls back to the oldest unpaired run when no type matches", () => {
  let map = applyEvent(EMPTY, "w1", preToolUse("s1", "toolu_1", "First", "explorer"), 100);
  map = applyEvent(map, "w1", preToolUse("s1", "toolu_2", "Second", "explorer"), 101);
  map = applyEvent(map, "w1", subagentStart("s1", "agent_1", "code-reviewer"), 102);
  assert.deepEqual(
    map.w1?.map((r) => [r.id, r.agentId]),
    [
      ["toolu_1", "agent_1"],
      ["toolu_2", undefined],
    ],
  );
});

test("SubagentStop ends the run with that agentId, wherever it is", () => {
  let map = applyEvent(EMPTY, "w1", preToolUse("s1", "toolu_1", "First"), 100);
  map = applyEvent(map, "w1", preToolUse("s1", "toolu_2", "Second"), 101);
  // The oldest unpaired run (toolu_1) is the one that gets this agent id.
  map = applyEvent(map, "w1", subagentStart("s1", "agent_2"), 102);
  map = applyEvent(map, "w1", subagentStop("agent_2"), 150);
  assert.deepEqual(
    map.w1?.map((r) => [r.id, r.endedEpoch]),
    [
      ["toolu_1", 150],
      ["toolu_2", undefined],
    ],
  );
});

test("SubagentStop with no matching run is a no-op", () => {
  const map = applyEvent(EMPTY, "w1", subagentStop("agent_missing"), 100);
  assert.deepEqual(map, EMPTY);
});

test("SubagentStop leaves a run that already has an endedEpoch unchanged", () => {
  let map = applyEvent(EMPTY, "w1", preToolUse("s1", "toolu_1", "First"), 100);
  map = applyEvent(map, "w1", subagentStart("s1", "agent_1"), 101);
  map = applyEvent(map, "w1", subagentStop("agent_1"), 150);
  const stopped = map.w1;
  // A redelivered Stop, later, must not bump endedEpoch to 200.
  map = applyEvent(map, "w1", subagentStop("agent_1"), 200);
  assert.deepEqual(map.w1, stopped);
  assert.equal(map.w1?.[0]?.endedEpoch, 150);
});

test("bad or unrecognised input is a no-op, never a throw", () => {
  for (const event of [null, undefined, "x", 3, {}, { hook_event_name: "PostToolUse" }]) {
    assert.deepEqual(applyEvent(EMPTY, "w1", event, 100), EMPTY);
  }
  assert.deepEqual(applyEvent(EMPTY, "w1", preToolUse("s1", "toolu_1"), 100).w1?.[0]?.label, "subagent");
  assert.deepEqual(applyEvent(EMPTY, "w1", { hook_event_name: "PreToolUse", tool_name: "Agent" }, 100), EMPTY);
});

test("prune drops a paired, still-running run more than two hours old", () => {
  const map: SubagentMap = {
    w1: [{ id: "toolu_1", session: "s1", agentId: "agent_1", label: "Old", startedEpoch: 0 }],
  };
  assert.deepEqual(prune(map, 2 * 60 * 60 + 1), {});
  assert.deepEqual(prune(map, 2 * 60 * 60), map);
});

test("prune drops an unpaired run (no agentId) after ten minutes, not two hours", () => {
  const map: SubagentMap = { w1: [{ id: "toolu_1", session: "s1", label: "Old", startedEpoch: 0 }] };
  assert.deepEqual(prune(map, 10 * 60 + 1), {});
  assert.deepEqual(prune(map, 10 * 60), map);
});

test("prune drops a finished run more than ten minutes after it ended", () => {
  const map: SubagentMap = {
    w1: [{ id: "toolu_1", session: "s1", label: "Done", startedEpoch: 0, endedEpoch: 100 }],
  };
  assert.deepEqual(prune(map, 100 + 10 * 60 + 1), {});
  assert.deepEqual(prune(map, 100 + 10 * 60), map);
});

test("prune drops an empty workspace but keeps others", () => {
  const map: SubagentMap = {
    w1: [{ id: "toolu_1", session: "s1", label: "Old", startedEpoch: 0 }],
    w2: [{ id: "toolu_2", session: "s2", agentId: "agent_2", label: "Paired", startedEpoch: 0 }],
  };
  assert.deepEqual(prune(map, 10 * 60 + 1), { w2: map.w2 });
});

test("visibleChange ignores a Start that only sets agentId", () => {
  const before: SubagentMap = { w1: [{ id: "toolu_1", session: "s1", label: "First", startedEpoch: 100 }] };
  const after: SubagentMap = {
    w1: [{ id: "toolu_1", session: "s1", agentId: "agent_1", label: "First", startedEpoch: 100 }],
  };
  assert.equal(visibleChange(before, after), false);
});

test("visibleChange is true for a new run, an ended run, or a pruned one", () => {
  const before: SubagentMap = { w1: [{ id: "toolu_1", session: "s1", label: "First", startedEpoch: 100 }] };
  const added: SubagentMap = {
    w1: [...(before.w1 ?? []), { id: "toolu_2", session: "s1", label: "Second", startedEpoch: 101 }],
  };
  assert.equal(visibleChange(before, added), true);

  const ended: SubagentMap = { w1: [{ ...(before.w1?.[0] as SubagentMap["w1"][number]), endedEpoch: 200 }] };
  assert.equal(visibleChange(before, ended), true);

  assert.equal(visibleChange(before, {}), true);
});

test("processEvent compares the validated maps, so a run the write would drop is never a false change", () => {
  // A session id over 128 characters fails state-config.ts's isId, so
  // validateState drops the whole run: comparing the raw before/after would
  // wrongly say this event changed something visible.
  const longSession = "s".repeat(200);
  const applied = processEvent({}, "w1", preToolUse(longSession, "toolu_1", "First"), 100);
  assert.deepEqual(applied.before, {});
  assert.deepEqual(applied.after, {});
  assert.equal(applied.changed, false);
});

test("processEvent reports a real, validated change", () => {
  const applied = processEvent({}, "w1", preToolUse("s1", "toolu_1", "First"), 100);
  assert.deepEqual(applied.after.w1, [{ id: "toolu_1", session: "s1", label: "First", startedEpoch: 100 }]);
  assert.equal(applied.changed, true);
});

test("buildUntilStable builds once and stops when nothing changed", () => {
  const calls = { build: 0, snapshot: 0 };
  buildUntilStable(
    () => {
      calls.build++;
      return true;
    },
    () => {
      calls.snapshot++;
      return "same";
    },
  );
  assert.deepEqual(calls, { build: 1, snapshot: 2 });
});

test("buildUntilStable builds again for each write that lands while it ran, until stable", () => {
  // v0 (before) -> build 1 -> v1 (changed, so build again) -> build 2 -> v2
  // (changed again) -> build 3 -> v2 (unchanged: stop).
  const snapshots = ["v0", "v1", "v2", "v2"];
  let i = 0;
  let builds = 0;
  buildUntilStable(
    () => {
      builds++;
      return true;
    },
    () => snapshots[i++] ?? "v2",
  );
  assert.equal(builds, 3);
});

test("buildUntilStable stops retrying once a build fails", () => {
  let builds = 0;
  buildUntilStable(
    () => {
      builds++;
      return false;
    },
    () => `v${builds}`,
  );
  assert.equal(builds, 1);
});

test("the build lock's stale threshold is comfortably above a build's timeout plus the coalesce delay", () => {
  assert.ok(BUILD_LOCK_STALE_MS >= 2 * BUILD_TIMEOUT_MS);
  assert.ok(BUILD_LOCK_STALE_MS > BUILD_TIMEOUT_MS + COALESCE_MS);
});
