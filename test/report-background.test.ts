// The pure parts of the background work hook: reading a Stop or
// SubagentStop's task list, replacing the chat's saved entries with it, and
// pruning what no list has confirmed for a long time. The real payloads in
// test/fixtures/background/ are replayed in their capture order. The
// lockfile and the stdin/env plumbing in main() are not covered.

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  applySnapshot,
  type ListedTask,
  listedTasks,
  MAX_AGE_S,
  prune,
  unstamped,
  update,
} from "../scripts/hooks/report-background.ts";
import { isRecord, MAX_TASKS, type SavedTask, type State, validateState } from "../scripts/state-config.ts";

type BackgroundMap = NonNullable<State["background"]>;

const FIXTURES = join(import.meta.dirname, "fixtures", "background");
const CHAT = "00000000-0000-4000-8000-00000000a001";
const AGENT = "a1b2c3d4e5f607182";

/** A fixture's payload, as the hook reads it on stdin. */
function payload(file: string): unknown {
  const parsed: unknown = JSON.parse(readFileSync(join(FIXTURES, file), "utf8"));
  assert.ok(isRecord(parsed), `${file} is an object`);
  return parsed.payload;
}

// The capture order the fixtures README gives, one file per row.
const RUN = [
  "post-tool-use-bash-background.json",
  "pre-tool-use-agent.json",
  "post-tool-use-agent-async.json",
  "subagent-start.json",
  "post-tool-use-monitor.json",
  "post-tool-use-claude-bg.json",
  "post-tool-use-agents-own-shell.json",
  "stop-turn-end-tasks-running.json",
  "subagent-stop-tasks-running.json",
  "stop-agent-ended-its-shell-in-parent-list.json",
  "subagent-stop-agent-woken-again.json",
  "stop-shell-and-monitor-left.json",
  "stop-one-shell-left.json",
  "stop-all-done.json",
];

const ids = (map: BackgroundMap, ws = "ws1") => (map[ws] ?? []).map((t) => t.id);

test("the replay covers every fixture", () => {
  const files = readdirSync(FIXTURES).filter((f) => f.endsWith(".json"));
  assert.deepEqual([...files].sort(), [...RUN].sort());
});

test("replaying the captured run fills the record, follows each list and empties it", () => {
  let map: BackgroundMap = {};
  const seen: [string, string[]][] = [];
  RUN.forEach((file, i) => {
    const before = map;
    map = update(map, "ws1", payload(file), 1000 + i * 10);
    if (listedTasks(payload(file)) === null) assert.equal(map, before, `${file} changes nothing`);
    else seen.push([file, ids(map)]);
  });
  assert.deepEqual(seen, [
    ["stop-turn-end-tasks-running.json", ["b8cvj4dry", AGENT, "byeh6pasn", "bujdab8j6"]],
    ["subagent-stop-tasks-running.json", ["b8cvj4dry", AGENT, "byeh6pasn", "bujdab8j6"]],
    ["stop-agent-ended-its-shell-in-parent-list.json", ["b8cvj4dry", "byeh6pasn", "bujdab8j6"]],
    ["subagent-stop-agent-woken-again.json", ["b8cvj4dry", AGENT, "byeh6pasn"]],
    ["stop-shell-and-monitor-left.json", ["b8cvj4dry", "byeh6pasn"]],
    ["stop-one-shell-left.json", ["b8cvj4dry"]],
    ["stop-all-done.json", []],
  ]);
  assert.deepEqual(map, {}, "the workspace key goes once nothing runs");
});

test("each fixture's tasks are saved under the chat's session, with their type and words", () => {
  const map = update({}, "ws1", payload("subagent-stop-tasks-running.json"), 500);
  const tasks = map.ws1 ?? [];
  assert.ok(tasks.every((t) => t.session === CHAT && t.status === "running" && t.seenEpoch === 500));
  assert.deepEqual(
    tasks.map((t) => [t.type, t.description]),
    [
      ["shell", "Sleep 200 seconds in background"],
      ["subagent", "Background sleep 170 then report"],
      ["shell", "190 second sleep then done"],
      ["shell", "Sleep in background"],
    ],
  );
  assert.deepEqual(validateState({ background: map }).background, map, "what the hook saves, the validator keeps");
});

test("a task keeps its start while listed; the agent's clock restarts when it comes back", () => {
  let map = update({}, "ws1", payload("stop-turn-end-tasks-running.json"), 100);
  map = update(map, "ws1", payload("stop-agent-ended-its-shell-in-parent-list.json"), 200);
  map = update(map, "ws1", payload("subagent-stop-agent-woken-again.json"), 300);
  const started = Object.fromEntries((map.ws1 ?? []).map((t) => [t.id, [t.startedEpoch, t.seenEpoch]]));
  assert.deepEqual(started, { b8cvj4dry: [100, 300], [AGENT]: [300, 300], byeh6pasn: [100, 300] });
});

const stop = (session: string, list: unknown, event = "Stop") => ({
  hook_event_name: event,
  session_id: session,
  background_tasks: list,
});
const shell = (id: string) => ({ id, type: "shell", status: "running", description: `run ${id}` });

test("a Stop without a list, or with something else in its place, leaves the record alone", () => {
  const map = update({}, "ws1", stop("s1", [shell("b1")]), 100);
  assert.equal(update(map, "ws1", { hook_event_name: "Stop", session_id: "s1" }, 200), map);
  assert.equal(update(map, "ws1", stop("s1", null), 200), map);
  assert.equal(update(map, "ws1", stop("s1", { b1: shell("b1") }), 200), map);
  assert.equal(update(map, "ws1", stop("s1", [], "PostToolUse"), 200), map);
  assert.equal(update(map, "ws1", stop("", []), 200), map, "no session, no owner to replace");
  assert.deepEqual(update(map, "ws1", stop("s1", []), 200), {}, "only an empty list empties it");
});

test("one entry that cannot be read is dropped, not the whole list", () => {
  const listed = listedTasks(
    stop("s1", [shell("b1"), "junk", { type: "shell" }, { id: "", type: "shell" }, shell("b2")]),
  );
  assert.deepEqual(
    listed?.map((t) => t.id),
    ["b1", "b2"],
  );
});

test("Claude Code's other labels are kept as they are, and a new one as other", () => {
  const list = ["monitor", "workflow", "teammate", "cloud session", "MCP task", "a new kind", 7].map((type, i) => ({
    id: `t${i}`,
    type,
    status: "running",
  }));
  const listed = listedTasks(stop("s1", list)) ?? [];
  assert.deepEqual(
    listed.map((t) => [t.type, t.description]),
    [
      ["monitor", "monitor"],
      ["workflow", "workflow"],
      ["teammate", "teammate"],
      ["cloud session", "cloud session"],
      ["MCP task", "MCP task"],
      ["other", "other"],
      ["other", "other"],
    ],
  );
});

test("a missing or odd status reads as running, and words are cleaned to one line", () => {
  const listed = listedTasks(
    stop("s1", [
      { id: "b1", type: "shell", description: "  two\nlines  " },
      { id: "b2", type: "shell", status: "x".repeat(40), description: "y".repeat(500) },
      { id: "b3", type: "shell", status: "pending" },
    ]),
  );
  assert.deepEqual(
    listed?.map((t) => [t.status, t.description.length]),
    [
      ["running", "two lines".length],
      ["running", 120],
      ["pending", "shell".length],
    ],
  );
});

const saved = (id: string, session: string, extra: Partial<SavedTask> = {}): SavedTask => ({
  id,
  type: "shell",
  status: "running",
  description: id,
  session,
  startedEpoch: 10,
  seenEpoch: 10,
  ...extra,
});
const listed = (id: string): ListedTask => ({ id, type: "shell", status: "running", description: id });

test("a snapshot replaces only its own session's entries, and moves a task listed under another", () => {
  const map: BackgroundMap = {
    ws1: [saved("mine", "s1"), saved("other chat", "s2"), saved("before clear", "s0")],
    ws2: [saved("elsewhere", "s1")],
  };
  const next = applySnapshot(map, "ws1", "s1", [listed("before clear"), listed("new")], 50);
  assert.deepEqual(
    next.ws1?.map((t) => [t.id, t.session, t.startedEpoch]),
    [
      ["other chat", "s2", 10],
      ["before clear", "s1", 10],
      ["new", "s1", 50],
    ],
  );
  assert.deepEqual(next.ws2, map.ws2, "another workspace is untouched");
});

test("a claude --bg session survives every snapshot, since no list holds it", () => {
  const bg = saved("5e5e5e5e", "s1", { type: "session" });
  const next = update({ ws1: [bg, saved("b1", "s1")] }, "ws1", stop("s1", []), 50);
  assert.deepEqual(next.ws1, [bg]);
});

test("the prune drops what no list has confirmed for MAX_AGE_S, and keeps a long task still listed", () => {
  const now = 100_000;
  const old = now - MAX_AGE_S - 1;
  const map: BackgroundMap = {
    ws1: [saved("dev server", "s1", { startedEpoch: old, seenEpoch: old })],
    ws2: [saved("stale", "s2", { seenEpoch: old }), saved("fresh", "s2", { seenEpoch: now - MAX_AGE_S })],
  };
  const next = update(map, "ws1", stop("s1", [shell("dev server")]), now);
  assert.deepEqual(next.ws1?.[0]?.startedEpoch, old, "listed again: kept, its clock unchanged");
  assert.deepEqual(ids(next, "ws2"), ["fresh"]);
  assert.deepEqual(prune({ ws3: [saved("gone", "s3", { seenEpoch: old })] }, now), {});
});

test("restamping alone reads as no change, in any key order", () => {
  const a: BackgroundMap = { ws1: [saved("b1", "s1")], ws2: [saved("b2", "s2")] };
  const b: BackgroundMap = { ws2: [saved("b2", "s2", { seenEpoch: 99 })], ws1: [saved("b1", "s1", { seenEpoch: 99 })] };
  assert.equal(unstamped(a), unstamped(b));
  assert.notEqual(unstamped(a), unstamped({ ws1: [saved("b1", "s1")] }));
});

test("validateState keeps the last MAX_TASKS tasks, drops bad ones on their own, reads a new type as other", () => {
  const many = Array.from({ length: MAX_TASKS + 3 }, (_, i) => saved(`b${i}`, "s1"));
  const raw = {
    background: {
      ws1: many,
      ws2: [
        { ...saved("kept", "s1"), type: "a new kind" },
        { ...saved("cloud", "s1"), type: "cloud session" },
        { ...saved("mcp", "s1"), type: "MCP task" },
        { ...saved("no epoch", "s1"), seenEpoch: -1 },
        { ...saved("bad status", "s1"), status: "" },
        { ...saved("bad words", "s1"), description: " padded " },
        { ...saved("no type", "s1"), type: 3 },
        "junk",
      ],
      ws3: [{ id: "x" }],
      ws4: "not a list",
    },
  };
  const state = validateState(raw);
  assert.equal(state.background?.ws1?.length, MAX_TASKS);
  assert.equal(state.background?.ws1?.[0]?.id, "b3");
  assert.deepEqual(
    state.background?.ws2?.map((t) => [t.id, t.type]),
    [
      ["kept", "other"],
      ["cloud", "cloud session"],
      ["mcp", "MCP task"],
    ],
  );
  assert.deepEqual(Object.keys(state.background ?? {}), ["ws1", "ws2"]);
  assert.equal("background" in validateState({ background: {} }), false, "left out while empty");
});
