// The `claude --bg` sessions a chat starts: saved from the Bash call's
// printed line (the captured payload plus synthetic ones), then settled
// on the chat's Stop against what `claude agents --json` says. The agents
// read itself is passed in, so no test runs Claude Code.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  GONE_GRACE_S,
  ID_PREFIX,
  launchedSessions,
  type SessionStates,
  sessionStates,
} from "../scripts/hooks/bg-sessions.ts";
import { foldFor, MAX_AGE_S, type Reads } from "../scripts/hooks/report-background.ts";
import { isRecord, MAX_TASKS, type SavedTask, type State, validateState } from "../scripts/state-config.ts";

type BackgroundMap = NonNullable<State["background"]>;

const FIXTURE = join(import.meta.dirname, "fixtures", "background", "post-tool-use-claude-bg.json");
const CHAT = "00000000-0000-4000-8000-00000000a001";
const PID = 4242;
const WS = "ws1";

function captured(): Record<string, unknown> {
  const parsed: unknown = JSON.parse(readFileSync(FIXTURE, "utf8"));
  assert.ok(isRecord(parsed) && isRecord(parsed.payload), "the fixture holds a payload");
  return parsed.payload;
}

/** A PostToolUse Bash call that ran `command` and printed `stdout`. */
const bash = (command: string, stdout: string, extra: Record<string, unknown> = {}) => ({
  session_id: CHAT,
  hook_event_name: "PostToolUse",
  tool_name: "Bash",
  tool_input: { command },
  tool_response: { stdout, stderr: "" },
  ...extra,
});

const HINTS = "\n  claude agents             list sessions\n  claude attach 0a1b2c3d    open in this terminal";
const stop = (list?: unknown[]) => ({
  session_id: CHAT,
  hook_event_name: "Stop",
  ...(list === undefined ? {} : { background_tasks: list }),
});

const never = (): never => {
  throw new Error("read when it should not be");
};
const reads = (saved: BackgroundMap, states: SessionStates | null = null): Reads => ({
  saved: () => saved,
  states: () => states,
});

/** The record after `event`, or the same map when the event does nothing. */
function after(map: BackgroundMap, event: unknown, now: number, r: Reads = reads(map), pid: number | undefined = PID) {
  const apply = foldFor(event, WS, now, r, pid);
  return apply === null ? map : apply(map);
}

/** A record holding one session the chat started at `at`. */
function started(at = 1000, short = "0a1b2c3d"): BackgroundMap {
  return after({}, bash("claude --bg go", `backgrounded · ${short}${HINTS}`), at);
}

const ids = (map: BackgroundMap) => (map[WS] ?? []).map((t) => t.id);
const task = (map: BackgroundMap, id: string): SavedTask | undefined => (map[WS] ?? []).find((t) => t.id === id);

test("the captured call, with its warning line first, saves the session under the chat", () => {
  const map = after({}, captured(), 1000);
  assert.deepEqual(map[WS], [
    {
      id: `${ID_PREFIX}5e5e5e5e`,
      type: "session",
      status: "running",
      description: "Start a background Claude session that replies ok",
      session: CHAT,
      pid: PID,
      startedEpoch: 1000,
      seenEpoch: 1000,
    },
  ]);
  assert.deepEqual(validateState({ background: map }).background, map, "the saved entry reads back unchanged");
});

test("the line without a warning reads the same, and a printed name is the description", () => {
  assert.deepEqual(launchedSessions(bash("claude --bg go", `backgrounded · 0a1b2c3d${HINTS}`)), [
    { short: "0a1b2c3d", description: "claude --bg" },
  ]);
  const named = bash("claude --bg --name x go", `backgrounded · 0a1b2c3d · Fix the  flaky test\r\n`);
  assert.deepEqual(launchedSessions(named), [{ short: "0a1b2c3d", description: "Fix the flaky test" }]);
});

test("the command is never the description, so a token in it stays out of the record", () => {
  const secret = bash("API_TOKEN=abc123 claude --bg go", `backgrounded · 0a1b2c3d${HINTS}`);
  assert.deepEqual(launchedSessions(secret), [{ short: "0a1b2c3d", description: "claude --bg" }]);
  const described = {
    ...secret,
    tool_input: { command: "API_TOKEN=abc123 claude --bg go", description: "Start a fix" },
  };
  assert.deepEqual(launchedSessions(described), [{ short: "0a1b2c3d", description: "Start a fix" }]);
});

test("a session printed on stderr, or two in one call, are each saved once", () => {
  const event = {
    ...bash("claude --bg a; claude --bg b; claude --bg a", "backgrounded · 0a1b2c3d"),
    tool_response: { stdout: "backgrounded · 0a1b2c3d", stderr: "backgrounded · 99999999" },
  };
  assert.deepEqual(
    launchedSessions(event).map((l) => l.short),
    ["0a1b2c3d", "99999999"],
  );
});

test("an agent's call saves the session under the chat's session and process", () => {
  const event = bash("claude --bg go", "backgrounded · 0a1b2c3d", {
    agent_id: "a1b2c3d4e5f607182",
    agent_type: "general-purpose",
  });
  const saved = task(after({}, event, 1000), `${ID_PREFIX}0a1b2c3d`);
  assert.equal(saved?.session, CHAT);
  assert.equal(saved?.pid, PID);
});

test("only a Bash call that runs --bg and prints the line on its own saves anything", () => {
  const line = `backgrounded · 0a1b2c3d${HINTS}`;
  assert.deepEqual(launchedSessions(bash("gh api issues/355/comments", line)), []);
  assert.deepEqual(launchedSessions(bash("claude --bgx go", line)), []);
  assert.deepEqual(launchedSessions(bash("claude --bg go", "said backgrounded · 0a1b2c3d")), []);
  assert.deepEqual(launchedSessions(bash("claude --bg go", "backgrounded · 0A1B2C3D")), []);
  assert.deepEqual(launchedSessions({ ...bash("claude --bg go", line), tool_name: "Read" }), []);
  assert.deepEqual(launchedSessions({ ...bash("claude --bg go", line), hook_event_name: "PreToolUse" }), []);
  assert.equal(foldFor({ ...bash("claude --bg go", line), session_id: 7 }, WS, 1000, reads({}), PID), null);
  assert.equal(foldFor(bash("ls", "a b"), WS, 1000, { saved: never, states: never }, PID), null);
});

test("saving again keeps the start; a full workspace leaves the new session out", () => {
  const again = started(1000);
  assert.equal(task(after(again, captured(), 1500), `${ID_PREFIX}0a1b2c3d`)?.startedEpoch, 1000);
  const resaved = after(again, bash("claude --bg go", "backgrounded · 0a1b2c3d"), 1500);
  assert.equal(task(resaved, `${ID_PREFIX}0a1b2c3d`)?.startedEpoch, 1000);
  assert.equal(task(resaved, `${ID_PREFIX}0a1b2c3d`)?.seenEpoch, 1500);

  const full: BackgroundMap = {
    [WS]: Array.from({ length: MAX_TASKS }, (_, i) => ({
      id: `t${i}`,
      type: "shell" as const,
      status: "running",
      description: "sleep",
      session: "other",
      startedEpoch: 1000,
      seenEpoch: 1000,
    })),
  };
  assert.deepEqual(ids(after(full, captured(), 1000)), ids(full));
});

test("a listed task with the session's short id never collides with the saved session", () => {
  const map = after(started(), stop([{ id: "0a1b2c3d", type: "shell", status: "running", description: "x" }]), 1010);
  assert.deepEqual(ids(map), [`${ID_PREFIX}0a1b2c3d`, "0a1b2c3d"]);
});

test("a Stop settles each state: running words restamp, settled words and the long gone drop", () => {
  const cases: [string, string | undefined, boolean][] = [
    ["working", "working", true],
    ["blocked", "blocked", true],
    ["a word Claude Code adds later", "paused", true],
    ["done", "done", false],
    ["failed", "failed", false],
    ["stopped", "stopped", false],
    ["gone", undefined, false],
  ];
  for (const [name, state, kept] of cases) {
    const map = started(1000);
    const states = new Map(state === undefined ? [] : [["0a1b2c3d", state]]);
    const next = after(map, stop([]), 2000, reads(map, states));
    const saved = task(next, `${ID_PREFIX}0a1b2c3d`);
    assert.equal(saved !== undefined, kept, name);
    if (kept) assert.equal(saved?.seenEpoch, 2000, name);
    if (!kept) assert.equal(next[WS], undefined, `${name} leaves the workspace empty`);
  }
});

test("a session just saved and not yet listed is kept, not restamped, until the grace runs out", () => {
  const map = started(1000);
  const soon = after(map, stop(), 1000 + GONE_GRACE_S - 1, reads(map, new Map()));
  assert.equal(task(soon, `${ID_PREFIX}0a1b2c3d`)?.seenEpoch, 1000);
  assert.deepEqual(after(map, stop(), 1000 + GONE_GRACE_S, reads(map, new Map())), {});
});

test("a failed agents read leaves the sessions alone, with or without a list", () => {
  const map = started(1000);
  assert.equal(foldFor(stop(), WS, 2000, reads(map, null), PID), null);
  const next = after(map, stop([]), 2000, reads(map, null));
  assert.deepEqual(next, map);
});

test("the agents are read only on the chat's Stop, and only when it owns a session", () => {
  let asked = 0;
  const counting = (map: BackgroundMap): Reads => ({
    saved: () => map,
    states: () => {
      asked++;
      return new Map([["0a1b2c3d", "working"]]);
    },
  });
  after({}, stop([]), 2000, counting({}));
  after(started(), stop([]), 2000, counting(started()), 1);
  const otherChat = { ...stop([]), session_id: "someone-else" };
  after(started(), otherChat, 2000, counting(started()), 1);
  after(started(), { ...stop([]), hook_event_name: "SubagentStop" }, 2000, counting(started()));
  assert.equal(asked, 1, "only the owner's Stop, matched by its session, asked");
  after(started(), { ...stop([]), session_id: "after-clear" }, 2000, counting(started()));
  assert.equal(asked, 2, "after a /clear the same process still owns its sessions");
});

test("the prune keeps a running session restamped by the Stop, and drops one no Stop confirmed", () => {
  const late = 1000 + MAX_AGE_S + 100;
  const map = started(1000);
  const running = new Map([["0a1b2c3d", "working"]]);
  const kept = after(map, stop([]), late, reads(map, running));
  assert.equal(task(kept, `${ID_PREFIX}0a1b2c3d`)?.seenEpoch, late);
  assert.deepEqual(after(map, stop([]), late, reads(map, null)), {});
});

test("another chat's session and another workspace's are left alone by a settle", () => {
  const theirs: SavedTask = {
    id: `${ID_PREFIX}ffffffff`,
    type: "session",
    status: "running",
    description: "theirs",
    session: "someone-else",
    pid: 1,
    startedEpoch: 1000,
    seenEpoch: 1000,
  };
  const map: BackgroundMap = { [WS]: [...(started(1000)[WS] ?? []), theirs], ws2: [{ ...theirs, session: CHAT }] };
  const next = after(map, stop([]), 2000, reads(map, new Map()));
  assert.deepEqual(next, { [WS]: [theirs], ws2: map.ws2 });
});

test("the agents list reads background sessions only, and anything not a list as a failed read", () => {
  const text = JSON.stringify([
    { id: "b8e3cc31", kind: "background", state: "blocked" },
    { id: "3f966ee2", kind: "background" },
    { pid: 5109, kind: "interactive", status: "idle" },
    { id: "", kind: "background", state: "working" },
    "junk",
  ]);
  assert.deepEqual(
    sessionStates(text),
    new Map([
      ["b8e3cc31", "blocked"],
      ["3f966ee2", ""],
    ]),
  );
  assert.equal(sessionStates("not json"), null);
  assert.equal(sessionStates("{}"), null);
});
