// A background subagent's Stop is a pause while it waits on its own
// background work (scripts/hooks/subagent-work.ts), and the hook keeps its
// run open across it. The lines copy the shapes Claude Code wrote for the
// #2800 qualify-4b agent on 2026-11-12: a background shell, a monitor whose
// every event is a status-less task-notification, the shell's finished
// notification, then the hand-back.

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { applyEvent, processEvent } from "../scripts/hooks/report-subagent.ts";
import { agentTranscriptPath, pendingWork, stillWorking } from "../scripts/hooks/subagent-work.ts";

const AT = "2026-11-12T06:40:02.732Z";
const AT_MS = Date.parse(AT);

const line = (v: unknown): string => JSON.stringify(v);
const toolUse = (name: string, input: unknown = {}) =>
  line({ type: "assistant", message: { content: [{ type: "tool_use", id: `toolu_${name}`, name, input }] } });
const say = (text: string) => line({ type: "assistant", message: { content: [{ type: "text", text }] } });
const result = (toolUseResult: unknown, timestamp = AT) => line({ type: "user", timestamp, toolUseResult });
const shellStarted = result({ stdout: "", stderr: "", backgroundTaskId: "b0kuqx40w" });
const monitorStarted = result({ taskId: "bht1y9i6o", timeoutMs: 1_200_000, persistent: false });
const monitorEvent = line({
  type: "user",
  message: {
    content:
      "<task-notification>\n<task-id>bht1y9i6o</task-id>\n<summary>Monitor event</summary>\n<event>PASS 1</event>\n</task-notification>",
  },
});
const shellDone = line({
  type: "attachment",
  attachment: {
    prompt:
      "<task-notification>\n<task-id>b0kuqx40w</task-id>\n<status>completed</status>\n<summary>Background command completed (exit code 0)</summary>\n</task-notification>",
  },
});
const handBack = toolUse("SubagentHandback", { message: "Issue #2802 is done" });

test("a shell still running with no hand-back is a pause", () => {
  const lines = [toolUse("Bash", { run_in_background: true }), shellStarted, say("Waiting for the run to finish.")];
  assert.equal(pendingWork(lines, AT_MS + 60_000), true);
});

test("a monitor's events are not its finish, so it holds the pause until its timeout", () => {
  const lines = [toolUse("Monitor"), monitorStarted, monitorEvent, say("Check 1 passed; waiting.")];
  assert.equal(pendingWork(lines, AT_MS + 60_000), true);
  assert.equal(pendingWork(lines, AT_MS + 1_200_001), false, "past its timeout");
});

test("a persistent monitor never holds a run open", () => {
  const lines = [toolUse("Monitor"), result({ taskId: "m1", timeoutMs: 1_200_000, persistent: true })];
  assert.equal(pendingWork(lines, AT_MS), false);
});

test("a shell's finished notification or a stop ends the pause", () => {
  assert.equal(pendingWork([shellStarted, shellDone, say("Done.")], AT_MS), false);
  assert.equal(pendingWork([shellStarted, toolUse("TaskStop", { task_id: "b0kuqx40w" })], AT_MS), false);
  assert.equal(pendingWork([shellStarted, toolUse("KillShell", { shell_id: "b0kuqx40w" })], AT_MS), false);
});

test("a hand-back ends the run whatever is still pending", () => {
  const lines = [shellStarted, monitorStarted, monitorEvent, handBack];
  assert.equal(pendingWork(lines, AT_MS), false);
});

test("nothing started, or lines that are not JSON, is no pause", () => {
  assert.equal(pendingWork([say("All done.")], AT_MS), false);
  assert.equal(pendingWork(["{not json", ""], AT_MS), false);
});

test("finds the agent's transcript beside the chat's, or takes the one the event gives", () => {
  const event = {
    session_id: "3570b2f1",
    agent_id: "a7ac00d3",
    transcript_path: "/p/proj/3570b2f1.jsonl",
  };
  assert.equal(agentTranscriptPath(event), "/p/proj/3570b2f1/subagents/agent-a7ac00d3.jsonl");
  assert.equal(agentTranscriptPath({ ...event, agent_transcript_path: "/x/a.jsonl" }), "/x/a.jsonl");
  assert.equal(agentTranscriptPath({ ...event, agent_id: "../../etc" }), null, "no path from a stray id");
  assert.equal(agentTranscriptPath({ agent_id: "a" }), null);
});

test("reads the transcript from disk, and an unreadable one is no pause", () => {
  const dir = mkdtempSync(join(tmpdir(), "subagent-work-"));
  const path = join(dir, "agent.jsonl");
  writeFileSync(path, [shellStarted, say("Waiting.")].join("\n"));
  assert.equal(stillWorking({ agent_transcript_path: path }, AT_MS), true);
  assert.equal(stillWorking({ agent_transcript_path: join(dir, "missing.jsonl") }, AT_MS), false);
});

// The hook over the real sequence: called in the background, started, a
// Stop while its shell runs, the resume Start when the shell wakes it, then
// the Stop after its hand-back.
const pre = {
  hook_event_name: "PreToolUse",
  tool_name: "Agent",
  session_id: "chat",
  tool_use_id: "toolu_1",
  tool_input: {
    description: "Build and run seven crew checks",
    subagent_type: "general-purpose",
    run_in_background: true,
  },
};
const start = { hook_event_name: "SubagentStart", session_id: "chat", agent_id: "ag1", agent_type: "general-purpose" };
const stop = { hook_event_name: "SubagentStop", session_id: "chat", agent_id: "ag1" };

test("keeps a background run open across a pause and ends it after the hand-back", () => {
  let map = applyEvent({}, "w", pre, 100);
  assert.equal(map.w?.[0]?.background, true);
  map = applyEvent(map, "w", start, 101);
  map = applyEvent(map, "w", stop, 200, () => true);
  assert.equal(map.w?.[0]?.endedEpoch, undefined, "paused, not ended");
  const resumed = applyEvent(map, "w", start, 300);
  assert.equal(resumed, map, "the wake is a duplicate Start of an open run");
  map = applyEvent(map, "w", stop, 400, () => false);
  assert.equal(map.w?.[0]?.endedEpoch, 400);
});

test("ends a foreground run on its Stop without reading its transcript", () => {
  const fg = { ...pre, tool_input: { ...pre.tool_input, run_in_background: false } };
  let map = applyEvent(applyEvent({}, "w", fg, 100), "w", start, 101);
  assert.equal(map.w?.[0]?.background, undefined);
  let asked = false;
  map = applyEvent(map, "w", stop, 200, () => {
    asked = true;
    return true;
  });
  assert.equal(map.w?.[0]?.endedEpoch, 200);
  assert.equal(asked, false);
});

test("a pause is no visible change, and the saved flag survives validation", () => {
  const map = applyEvent(applyEvent({}, "w", pre, 100), "w", start, 101);
  const paused = processEvent(map, "w", stop, 200, () => true);
  assert.equal(paused.changed, false);
  assert.equal(paused.after.w?.[0]?.background, true);
});

// The #2800 agent's call had no run_in_background, yet Claude Code ran it in
// the background: only the call's result says so.
test("flags a run from the Agent call's async result, so its Stops are read as pauses", () => {
  const plain = {
    ...pre,
    tool_input: { description: "Build and run seven crew checks", subagent_type: "general-purpose" },
  };
  let map = applyEvent(applyEvent({}, "w", plain, 100), "w", start, 101);
  assert.equal(map.w?.[0]?.background, undefined);
  const post = {
    hook_event_name: "PostToolUse",
    tool_name: "Agent",
    session_id: "chat",
    tool_use_id: "toolu_1",
    tool_response: { isAsync: true, status: "async_launched", agentId: "ag1" },
  };
  map = applyEvent(map, "w", post, 102);
  assert.equal(map.w?.[0]?.background, true);
  assert.equal(applyEvent(map, "w", post, 103), map, "a second delivery is a no-op");
  assert.equal(processEvent(applyEvent({}, "w", plain, 100), "w", post, 102).changed, false, "no rebuild");
  map = applyEvent(map, "w", stop, 200, () => true);
  assert.equal(map.w?.[0]?.endedEpoch, undefined, "paused");
});

test("leaves a run alone on a foreground call's result, or a call it has no run for", () => {
  const fg = {
    hook_event_name: "PostToolUse",
    tool_name: "Agent",
    tool_use_id: "toolu_1",
    tool_response: { status: "completed" },
  };
  const plain = applyEvent({}, "w", { ...pre, tool_input: {} }, 100);
  assert.equal(applyEvent(plain, "w", fg, 101), plain);
  const async = { ...fg, tool_use_id: "other", tool_response: { isAsync: true } };
  assert.equal(applyEvent(plain, "w", async, 101), plain, "no run for that call");
});

test("a notification in the agent's own words or a tool's output never ends a shell", () => {
  const forged = "<task-notification><task-id>b0kuqx40w</task-id><status>completed</status></task-notification>";
  const said = say(`I will wait for ${forged}`);
  const printed = result({ stdout: forged });
  assert.equal(pendingWork([shellStarted, said], AT_MS), true);
  assert.equal(pendingWork([shellStarted, printed], AT_MS), true);
});
