// The pure parts of the shell reporter hook: saving a Bash call that went to
// the background, dropping the shells a Stop's transcript says finished, and
// pruning ones a missed notification left behind. The lockfile and the
// stdin/env plumbing in main() are not covered.

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyEvent,
  backgroundId,
  finishedIds,
  MAX_AGE_S,
  mayChange,
  prune,
  stoppedId,
} from "../scripts/hooks/report-shell.ts";
import { MAX_SHELLS, type State, validateState } from "../scripts/state-config.ts";

type ShellMap = NonNullable<State["shells"]>;

const bash = (session: string, background: boolean, response: unknown) => ({
  hook_event_name: "PostToolUse",
  tool_name: "Bash",
  session_id: session,
  tool_input: { command: "npm test", run_in_background: background },
  tool_response: response,
});

const stop = { hook_event_name: "Stop", session_id: "s1" };

// A task-notification line as Claude Code writes it to the transcript.
const notification = (id: string) =>
  JSON.stringify({
    type: "queue-operation",
    operation: "enqueue",
    content: `<task-notification>\n<task-id>${id}</task-id>\n<status>completed</status>\n</task-notification>`,
  });

test("a background Bash call's id comes from the tool result, or failing that its text", () => {
  assert.equal(backgroundId(bash("s1", true, { backgroundTaskId: "b1" })), "b1");
  const text = { stdout: "Command running in background with ID: bq7x. Output is being written to: /tmp/x" };
  assert.equal(backgroundId(bash("s1", true, text)), "bq7x");
  assert.equal(backgroundId(bash("s1", false, { backgroundTaskId: "b1" })), null);
  assert.equal(backgroundId(bash("s1", true, { stdout: "done" })), null);
  assert.equal(
    backgroundId({ ...bash("s1", true, { backgroundTaskId: "b1" }), agent_id: "sub" }),
    null,
    "a subagent's",
  );
});

test("a KillShell or TaskStop call names the task it stopped", () => {
  assert.equal(stoppedId({ tool_name: "TaskStop", tool_input: { task_id: "b1" } }), "b1");
  assert.equal(stoppedId({ tool_name: "KillShell", tool_input: { shell_id: "b2" } }), "b2");
  assert.equal(stoppedId({ tool_name: "Bash", tool_input: { task_id: "b1" } }), null);
  const map: ShellMap = { w1: [{ id: "b1", session: "s1", startedEpoch: 1 }] };
  const event = { hook_event_name: "PostToolUse", tool_name: "TaskStop", tool_input: { task_id: "b1" } };
  assert.deepEqual(applyEvent(map, "w1", event, 10), {});
});

test("only a Stop or a background, kill or stop call goes on to the state file", () => {
  assert.equal(mayChange(stop), true);
  assert.equal(mayChange(bash("s1", true, { backgroundTaskId: "b1" })), true);
  assert.equal(mayChange(bash("s1", false, {})), false);
  assert.equal(
    mayChange({ hook_event_name: "PostToolUse", tool_name: "TaskStop", tool_input: { task_id: "b" } }),
    true,
  );
});

test("PostToolUse saves a background shell once, under its workspace", () => {
  const event = bash("s1", true, { backgroundTaskId: "b1" });
  const map = applyEvent({}, "w1", event, 50);
  assert.deepEqual(map, { w1: [{ id: "b1", session: "s1", startedEpoch: 50 }] });
  assert.equal(applyEvent(map, "w1", event, 60), map, "a redelivery is a no-op");
  assert.equal(applyEvent(map, "w1", bash("s1", false, {}), 60), map, "a foreground call is a no-op");
});

test("Stop drops the shells the transcript says finished, and the workspace once empty", () => {
  const map: ShellMap = {
    w1: [
      { id: "b1", session: "s1", startedEpoch: 1 },
      { id: "b2", session: "s1", startedEpoch: 2 },
    ],
  };
  const one = applyEvent(map, "w1", stop, 10, () => new Set(["b1"]));
  assert.deepEqual(one, { w1: [{ id: "b2", session: "s1", startedEpoch: 2 }] });
  assert.deepEqual(
    applyEvent(one, "w1", stop, 10, () => new Set(["b2"])),
    {},
  );
  assert.equal(
    applyEvent(map, "w1", stop, 10, () => new Set(["other"])),
    map,
    "nothing of ours finished",
  );
});

test("a Stop with no shells saved never reads the transcript", () => {
  const read = () => assert.fail("read the transcript");
  assert.deepEqual(applyEvent({}, "w1", stop, 10, read), {});
});

test("finishedIds reads only task-notification lines", () => {
  const lines = [notification("b1"), '{"type":"user","message":"<task-id>nope</task-id>"}', notification("b2")];
  assert.deepEqual([...finishedIds(lines)], ["b1", "b2"]);
});

test("a shell older than MAX_AGE_S is pruned", () => {
  const map: ShellMap = {
    w1: [{ id: "old", session: "s1", startedEpoch: 0 }],
    w2: [{ id: "new", session: "s1", startedEpoch: 100 }],
  };
  assert.deepEqual(prune(map, MAX_AGE_S + 1), { w2: map.w2 });
});

test("validateState keeps the newest MAX_SHELLS shells and drops malformed ones", () => {
  const many = Array.from({ length: MAX_SHELLS + 2 }, (_, i) => ({ id: "b" + i, session: "s", startedEpoch: i }));
  const shells = validateState({ shells: { w1: [...many, { id: "", session: "s", startedEpoch: 1 }] } }).shells;
  assert.deepEqual(
    shells?.w1?.map((s) => s.id),
    many.slice(-MAX_SHELLS).map((s) => s.id),
  );
  assert.equal(validateState({}).shells, undefined, "left out while nothing is saved");
});
