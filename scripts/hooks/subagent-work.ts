// Whether a background subagent that just stopped is only pausing: it
// ended its turn to wait on background work of its own (a shell or a
// monitor), and that work will wake it. Claude Code sends SubagentStop at
// every such pause, so without this a background agent waiting on its own
// shell read as finished and its chat's card said Idle (2026-11-12, the
// #2800 qualify-4b card). Read from the subagent's own transcript, the
// only place its background tasks and their notifications are written.
//
// A run counts as done once the agent hands back (its SubagentHandback
// call, the end Claude Code itself reports to the chat), whatever is
// still pending; until then it is pausing while a shell has no finished
// notification and no stop, or a monitor is inside its timeout. A
// persistent monitor has no timeout, so it never holds a run open: the
// two-hour prune would be the only thing to close it.

import { dirname, join } from "node:path";
import { field } from "./gh-command.ts";
import { readTail, TAIL_BYTES } from "./transcript.ts";

const HANDBACK_TOOL = "SubagentHandback";
const STOP_TOOLS: readonly unknown[] = ["KillShell", "TaskStop"];
const NOTIFICATION = /<task-notification>([\s\S]*?)<\/task-notification>/g;
const TASK_ID = /<task-id>([\w-]+)<\/task-id>/;
/** A line holds nothing pendingWork reads unless it has one of these. */
const MAY_MATTER = ["task-notification", "backgroundTaskId", '"taskId"', '"tool_use"'];

interface Work {
  /** Background shells started, by task id. */
  shells: Set<string>;
  /** Bounded monitors started, task id to the epoch ms they time out. */
  monitors: Map<string, number>;
  /** Task ids with a finished notification (one with a status) or a stop. */
  done: Set<string>;
  /** The name of the agent's latest tool call. */
  lastTool: unknown;
}

function parse(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}

function toolUses(entry: unknown): unknown[] {
  if (field(entry, "type") !== "assistant") return [];
  const content = field(field(entry, "message"), "content");
  return Array.isArray(content) ? content.filter((b) => field(b, "type") === "tool_use") : [];
}

// A shell's result names its backgroundTaskId; a monitor's its taskId and timeoutMs.
function noteStarted(work: Work, entry: unknown): void {
  const result = field(entry, "toolUseResult");
  const shell = field(result, "backgroundTaskId");
  if (typeof shell === "string" && shell) work.shells.add(shell);
  const task = field(result, "taskId");
  const timeout = field(result, "timeoutMs");
  const at = Date.parse(String(field(entry, "timestamp")));
  if (typeof task !== "string" || !task || field(result, "persistent") === true) return;
  if (typeof timeout === "number" && timeout > 0 && Number.isFinite(at)) work.monitors.set(task, at + timeout);
}

// A monitor's every event is a task-notification too; only one carrying a
// status says the task finished. Only an entry Claude Code delivered counts:
// the agent's own words, or a tool's output that prints a notification (a
// log, a quoted transcript), never ends a task.
function noteFinished(work: Work, line: string, entry: unknown): void {
  if (!line.includes("task-notification")) return;
  if (field(entry, "type") === "assistant" || field(entry, "toolUseResult") !== undefined) return;
  for (const m of line.matchAll(NOTIFICATION)) {
    const body = m[1] ?? "";
    const id = TASK_ID.exec(body)?.[1];
    if (id && body.includes("<status>")) work.done.add(id);
  }
}

function noteTools(work: Work, entry: unknown): void {
  for (const use of toolUses(entry)) {
    const name = field(use, "name");
    work.lastTool = name;
    if (!STOP_TOOLS.includes(name)) continue;
    const input = field(use, "input");
    const id = field(input, "task_id") ?? field(input, "shell_id");
    if (typeof id === "string" && id) work.done.add(id);
  }
}

/** True when these transcript lines show the agent waiting on background work of its own, not handed back. */
export function pendingWork(lines: readonly string[], nowMs: number): boolean {
  const work: Work = { shells: new Set(), monitors: new Map(), done: new Set(), lastTool: undefined };
  for (const line of lines) {
    if (!MAY_MATTER.some((s) => line.includes(s))) continue;
    const entry = parse(line);
    if (entry === undefined) continue;
    noteFinished(work, line, entry);
    noteStarted(work, entry);
    noteTools(work, entry);
  }
  if (work.lastTool === HANDBACK_TOOL) return false;
  for (const id of work.shells) if (!work.done.has(id)) return true;
  for (const [id, until] of work.monitors) if (!work.done.has(id) && until > nowMs) return true;
  return false;
}

/**
 * The subagent's transcript: the event's agent_transcript_path, else
 * where Claude Code keeps it, beside the chat's own transcript under
 * `<session>/subagents/agent-<id>.jsonl`. Null when neither can be known.
 */
export function agentTranscriptPath(event: unknown): string | null {
  const given = field(event, "agent_transcript_path");
  if (typeof given === "string" && given) return given;
  const parent = field(event, "transcript_path");
  const session = field(event, "session_id");
  const agentId = field(event, "agent_id");
  if (typeof parent !== "string" || typeof session !== "string" || typeof agentId !== "string") return null;
  if (!/^[\w-]+$/.test(session) || !/^[\w-]+$/.test(agentId)) return null;
  return join(dirname(parent), session, "subagents", `agent-${agentId}.jsonl`);
}

/** Whether the stopped subagent is pausing on its own background work; false when its transcript cannot be read. */
export function stillWorking(event: unknown, nowMs: number): boolean {
  const path = agentTranscriptPath(event);
  if (path === null) return false;
  try {
    return pendingWork(readTail(path, TAIL_BYTES), nowMs);
  } catch {
    return false;
  }
}
