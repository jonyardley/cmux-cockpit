// Tells cmux about the background shells a workspace's chats have running:
// custom sidebars get no shell data from cmux at all, so this hook is the
// only source, and a card can say "Waiting · 1 shell" rather than a bare
// Idle while a chat's build or test run is still going.
//
// Run by scripts/hooks/dispatch.ts on two Claude Code events, as
// scripts/hooks/routes.ts lists them. PostToolUse on Bash saves a shell
// when the call ran in the background, keyed by the task id Claude Code
// gave it, and PostToolUse on KillShell or TaskStop drops the one stopped. Stop reads the transcript's tail for task-notifications, which
// Claude Code enqueues when a background task finishes or is stopped, and
// drops the shells they name. A finished shell always wakes its chat, and
// that turn ends in a Stop, so the drop is prompt. It never fails the hook:
// a missing workspace id, bad JSON or an event it does not use is a quiet
// exit 0; anything else wrong goes to stderr.
//
// Nothing is fatal if an event is missed (a shell whose output the chat
// read to the end with TaskOutput may never get a notification): a shell older than MAX_AGE_S is
// pruned on the next event, and the sidebar counts a shell only while the
// chat that started it is still open (src/shared/shells.ts).

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { scheduleBuild } from "../hook-build.ts";
import type { SavedShell, State } from "../state-config.ts";
import { writeShells } from "../state-url.ts";
import { field } from "./gh-command.ts";
import { readTail } from "./transcript.ts";

type ShellMap = NonNullable<State["shells"]>;

/** A shell this old is taken as missed and dropped: longer than any real build or test run here. */
export const MAX_AGE_S = 12 * 60 * 60;

// The transcript tail a Stop reads. A notification lands in the turn that
// ends in this Stop, so it sits near the end; the margin covers a turn
// that read large files after it.
const TAIL_BYTES = 2 * 1024 * 1024;

// Claude Code's text when the tool result carries no backgroundTaskId.
const ID_IN_TEXT = /running in background with ID: ([\w-]+)/;

/** The task id of a main-chat Bash call that went to the background, or null for anything else. */
export function backgroundId(event: unknown): string | null {
  if (field(event, "tool_name") !== "Bash") return null;
  // A subagent's shell reports its finish to the subagent, never to the
  // Stop this hook reads, so it would never clear.
  if (field(event, "agent_id") !== undefined) return null;
  if (field(field(event, "tool_input"), "run_in_background") !== true) return null;
  const response = field(event, "tool_response");
  const id = field(response, "backgroundTaskId");
  if (typeof id === "string" && id) return id;
  const text = field(response, "stdout");
  return typeof text === "string" ? (ID_IN_TEXT.exec(text)?.[1] ?? null) : null;
}

// The tools that stop a background task, by name then and now.
const STOP_TOOLS: readonly unknown[] = ["KillShell", "TaskStop"];

/** The task id a KillShell or TaskStop call stopped, or null for anything else. */
export function stoppedId(event: unknown): string | null {
  if (!STOP_TOOLS.includes(field(event, "tool_name"))) return null;
  const input = field(event, "tool_input");
  const id = field(input, "task_id") ?? field(input, "shell_id");
  return typeof id === "string" && id ? id : null;
}

const TASK_ID = /<task-id>([\w-]+)<\/task-id>/g;

/** Every task id a task-notification in these transcript lines names. */
export function finishedIds(lines: readonly string[]): Set<string> {
  const ids = new Set<string>();
  for (const line of lines) {
    if (!line.includes("task-notification")) continue;
    for (const m of line.matchAll(TASK_ID)) if (m[1]) ids.add(m[1]);
  }
  return ids;
}

function onToolUse(shells: SavedShell[], event: unknown, now: number): SavedShell[] {
  const stopped = stoppedId(event);
  if (stopped !== null) return onStop(shells, new Set([stopped]));
  const id = backgroundId(event);
  const session = field(event, "session_id");
  if (id === null || typeof session !== "string" || shells.some((s) => s.id === id)) return shells;
  return [...shells, { id, session, startedEpoch: now }];
}

function onStop(shells: SavedShell[], finished: ReadonlySet<string>): SavedShell[] {
  return shells.some((s) => finished.has(s.id)) ? shells.filter((s) => !finished.has(s.id)) : shells;
}

/**
 * Folds one hook event into a workspace's shells. `finished` reads what the
 * transcript says has ended; it is called only for a Stop with shells
 * saved, so most Stops never read the transcript. An event this hook does
 * not use is a no-op.
 */
export function applyEvent(
  map: ShellMap,
  wsId: string,
  event: unknown,
  now: number,
  finished: () => ReadonlySet<string> = () => new Set(),
): ShellMap {
  const shells = map[wsId] ?? [];
  const hookName = field(event, "hook_event_name");
  const next =
    hookName === "PostToolUse"
      ? onToolUse(shells, event, now)
      : hookName === "Stop" && shells.length
        ? onStop(shells, finished())
        : shells;
  if (next === shells) return map;
  const { [wsId]: _, ...rest } = map;
  return next.length ? { ...rest, [wsId]: next } : rest;
}

/** Drops shells older than MAX_AGE_S across every workspace, and any workspace left with none. */
export function prune(map: ShellMap, now: number): ShellMap {
  const out: ShellMap = {};
  for (const [wsId, shells] of Object.entries(map)) {
    const kept = shells.filter((s) => now - s.startedEpoch <= MAX_AGE_S);
    if (kept.length) out[wsId] = kept;
  }
  return out;
}

/** What a Stop's transcript says has finished; nothing when the file cannot be read. */
function finishedFor(event: unknown): () => Set<string> {
  return () => {
    const path = field(event, "transcript_path");
    if (typeof path !== "string") return new Set();
    try {
      return finishedIds(readTail(path, TAIL_BYTES));
    } catch {
      return new Set();
    }
  };
}

/** True for an event that can change the saved shells, so the rest skip the lock and the state read. */
export const mayChange = (event: unknown): boolean =>
  field(event, "hook_event_name") === "Stop" || backgroundId(event) !== null || stoppedId(event) !== null;

const ROOT = join(import.meta.dirname, "..", "..");
const STATE_PATH = join(ROOT, "config", "state.json");

async function main(): Promise<void> {
  const wsId = process.env.CMUX_WORKSPACE_ID;
  if (!wsId) return;
  let event: unknown;
  try {
    event = JSON.parse(readFileSync(0, "utf8"));
  } catch {
    return;
  }
  if (!mayChange(event)) return;
  const now = Math.floor(Date.now() / 1000);
  let result: ReturnType<typeof writeShells>;
  try {
    result = writeShells(STATE_PATH, (shells) => prune(applyEvent(shells, wsId, event, now, finishedFor(event)), now));
  } catch (err) {
    console.error(`report-shell: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  if (!result.ok) return console.error(`report-shell: ${result.error}`);
  if (result.changed) scheduleBuild("report-shell", "slow");
}

if (import.meta.main) await main();
