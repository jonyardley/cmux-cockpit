// The pure parts of the background work hook: reading a Stop or
// SubagentStop's task list, replacing the chat's saved entries with it, and
// pruning what no list has confirmed for a long time. The real payloads in
// test/fixtures/background/ are replayed in their capture order. The
// lockfile and the stdin/env plumbing in main() are not covered.

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { ID_PREFIX, launchedSessions, type SessionStates } from "../scripts/hooks/bg-sessions.ts";
import {
  applySnapshot,
  foldFor,
  type ListedTask,
  listedTasks,
  pidFrom,
  prune,
  unstamped,
  update,
} from "../scripts/hooks/report-background.ts";
import { MAX_AGE_S } from "../scripts/hooks/report-shell.ts";
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

const BG = `${ID_PREFIX}5e5e5e5e`;

/** What `claude agents --json` says of the captured `claude --bg` session at each event: working, then done by the last Stop. */
const agentsAt = (file: string): SessionStates =>
  new Map([["5e5e5e5e", file === "stop-all-done.json" ? "done" : "working"]]);

/** The captured run replayed through the hook's own fold, with the record after each list. */
function replay(pid?: number): { map: BackgroundMap; seen: [string, BackgroundMap][] } {
  let map: BackgroundMap = {};
  const seen: [string, BackgroundMap][] = [];
  RUN.forEach((file, i) => {
    const before = map;
    const event = payload(file);
    const apply = foldFor(event, "ws1", 1000 + i * 10, { saved: () => before, states: () => agentsAt(file) }, pid);
    map = apply === null ? map : apply(map);
    if (listedTasks(event) !== null) seen.push([file, map]);
    else if (launchedSessions(event).length) assert.deepEqual(ids(map), [BG], `${file} saves the session`);
    else assert.equal(map, before, `${file} changes nothing`);
  });
  return { map, seen };
}

test("replaying the captured run fills the record, follows each list and empties it", () => {
  const { map, seen } = replay();
  assert.deepEqual(
    seen.map(([file, m]) => [file, ids(m)]),
    [
      ["stop-turn-end-tasks-running.json", [BG, "b8cvj4dry", AGENT, "byeh6pasn", "bujdab8j6"]],
      ["subagent-stop-tasks-running.json", [BG, "b8cvj4dry", AGENT, "byeh6pasn", "bujdab8j6"]],
      ["stop-agent-ended-its-shell-in-parent-list.json", [BG, "b8cvj4dry", "byeh6pasn", "bujdab8j6"]],
      ["subagent-stop-agent-woken-again.json", [BG, "b8cvj4dry", "byeh6pasn", AGENT]],
      ["stop-shell-and-monitor-left.json", [BG, "b8cvj4dry", "byeh6pasn"]],
      ["stop-one-shell-left.json", [BG, "b8cvj4dry"]],
      ["stop-all-done.json", []],
    ],
  );
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
  const next = applySnapshot(map, "ws1", { session: "s1", listed: [listed("before clear"), listed("new")] }, 50);
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

test("a listed task calling itself session is saved as other, so it still leaves with the list", () => {
  const listing = stop("s1", [{ id: "x", type: "session", status: "running" }]);
  let map = update({}, "ws1", listing, 10);
  map = update(map, "ws1", listing, 20);
  assert.deepEqual(
    map.ws1?.map((t) => [t.id, t.type]),
    [["x", "other"]],
  );
  assert.deepEqual(update(map, "ws1", stop("s1", []), 30), {});
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
        { ...saved("pid", "s1"), pid: 4242 },
        { ...saved("null pid", "s1"), pid: null },
        { ...saved("zero pid", "s1"), pid: 0 },
        { ...saved("text pid", "s1"), pid: "42" },
        { ...saved("minus pid", "s1"), pid: -1 },
        { ...saved("big pid", "s1"), pid: 4294967296 },
        { ...saved("half pid", "s1"), pid: 4.5 },
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
      ["pid", "shell"],
      ["null pid", "shell"],
    ],
  );
  assert.equal(state.background?.ws2?.[3]?.pid, 4242);
  assert.equal("pid" in (state.background?.ws2?.[4] ?? {}), false, "a null pid reads as none");
  assert.deepEqual(Object.keys(state.background ?? {}), ["ws1", "ws2"]);
  assert.equal("background" in validateState({ background: {} }), false, "left out while empty");
});

// A /clear replayed on the captured run: the same Claude process (pid 4242)
// lists under a new session id after the clear.
const CLEARED = "00000000-0000-4000-8000-00000000a002";
const relisted = (file: string, session: string) => {
  const p = payload(file);
  assert.ok(isRecord(p));
  return { ...p, session_id: session };
};

test("after a /clear, the process's first list retires what it no longer holds and moves the rest", () => {
  const before = update({}, "ws1", payload("stop-turn-end-tasks-running.json"), 100, 4242);
  const after = update(before, "ws1", relisted("stop-one-shell-left.json", CLEARED), 200, 4242);
  assert.deepEqual(
    after.ws1?.map((t) => [t.id, t.session, t.startedEpoch, t.pid]),
    [["b8cvj4dry", CLEARED, 100, 4242]],
  );
});

test("after a /clear, an empty list from the same process clears what it saved before", () => {
  const before = update({}, "ws1", payload("stop-turn-end-tasks-running.json"), 100, 4242);
  assert.deepEqual(update(before, "ws1", stop(CLEARED, []), 200, 4242), {});
});

test("another Claude process in the workspace, a nested one included, leaves the chat's work alone", () => {
  const before = update({}, "ws1", payload("stop-turn-end-tasks-running.json"), 100, 4242);
  const nested = update(before, "ws1", stop("nested", [shell("its own")]), 200, 5151);
  assert.deepEqual(ids(nested), ["b8cvj4dry", AGENT, "byeh6pasn", "bujdab8j6", "its own"]);
  assert.deepEqual(ids(update(nested, "ws1", stop("nested", []), 300, 5151)), ids(before));
});

test("with no pid, a list replaces its own session only, as before", () => {
  const before = update({}, "ws1", payload("stop-turn-end-tasks-running.json"), 100);
  assert.deepEqual(ids(update(before, "ws1", stop(CLEARED, []), 200)), ids(before));
  assert.equal(
    before.ws1?.some((t) => "pid" in t),
    false,
  );
});

test("the pid is read from CLAUDE_PID only when it is a whole number in range", () => {
  assert.equal(pidFrom("4242"), 4242);
  for (const bad of [undefined, "", "0", "-1", "4.2", "42x", "4294967296"])
    assert.equal(pidFrom(bad), undefined, String(bad));
});

test("two chats taking turns keep the saved order, so restamping asks for no build", () => {
  let map = update({}, "ws1", stop("s1", [shell("a")]), 10);
  map = update(map, "ws1", stop("s2", [shell("b")]), 20);
  const settled = unstamped(map);
  map = update(map, "ws1", stop("s1", [shell("a")]), 30);
  map = update(map, "ws1", stop("s2", [shell("b")]), 40);
  assert.equal(unstamped(map), settled);
  assert.deepEqual(ids(map), ["a", "b"]);
});

test("a busy chat never pushes out another chat's work or a claude --bg session", () => {
  const theirs = [saved("theirs", "s2"), saved("5e5e5e5e", "s1", { type: "session" })];
  const many = Array.from({ length: MAX_TASKS + 5 }, (_, i) => shell(`b${i}`));
  const map = update({ ws1: theirs }, "ws1", stop("s1", many), 50);
  assert.equal(map.ws1?.length, MAX_TASKS);
  assert.deepEqual(ids(map).slice(0, 3), ["theirs", "5e5e5e5e", "b0"]);
  assert.equal(validateState({ background: map }).background?.ws1?.length, MAX_TASKS, "the validator cuts nothing");
});

test("a task listed twice is saved once, and one listed as ended is not saved", () => {
  const map = update(
    {},
    "ws1",
    stop("s1", [
      shell("b1"),
      { ...shell("b1"), description: "again" },
      { ...shell("b2"), status: "completed" },
      { ...shell("b3"), status: "failed" },
      { ...shell("b4"), status: "killed" },
    ]),
    50,
  );
  assert.deepEqual(
    map.ws1?.map((t) => [t.id, t.description]),
    [["b1", "run b1"]],
  );
});

test("the captured run replays the same with a pid, which every saved task then carries", () => {
  const strip = (m: BackgroundMap) => JSON.stringify(m, (key, value: unknown) => (key === "pid" ? undefined : value));
  const plain = replay().seen;
  const withPid = replay(4242).seen;
  assert.deepEqual(
    withPid.map(([file, m]) => [file, strip(m)]),
    plain.map(([file, m]) => [file, strip(m)]),
  );
  for (const [, m] of withPid) assert.ok((m.ws1 ?? []).every((t) => t.pid === 4242));
});

test("after a /clear, an empty list from the same process keeps a claude --bg session it saved", () => {
  const bg = saved("5e5e5e5e", "s0", { type: "session", pid: 4242 });
  const before = update({ ws1: [bg] }, "ws1", payload("stop-turn-end-tasks-running.json"), 100, 4242);
  assert.deepEqual(update(before, "ws1", stop(CLEARED, []), 200, 4242), { ws1: [bg] });
});

test("the same pid in another workspace is left alone", () => {
  const map = { ws2: [saved("elsewhere", "s0", { pid: 4242, seenEpoch: 150 })] };
  assert.deepEqual(update(map, "ws1", stop(CLEARED, []), 200, 4242), map);
});

test("a task listed as ended takes out its saved copy under another session", () => {
  const map = { ws1: [saved("b1", "s0"), saved("b2", "s0")] };
  const next = update(map, "ws1", stop("s1", [{ ...shell("b1"), status: "completed" }]), 50);
  assert.deepEqual(ids(next), ["b2"]);
});
