// Tells cmux about the background shells a workspace's chats have running:
// custom sidebars get no shell data from cmux at all, so this hook is the
// only source, and a card can say "Waiting · 1 shell" rather than a bare
// Idle while a chat's build or test run is still going.
//
// Run by scripts/hooks/dispatch.ts on two Claude Code events, as
// scripts/hooks/routes.ts lists them. PostToolUse on Bash saves a shell
// when the call ran in the background, keyed by the task id Claude Code
// gave it. Stop reads the transcript's tail for task-notifications, which
// Claude Code enqueues when a background task finishes or is stopped, and
// drops the shells they name. A finished shell always wakes its chat, and
// that turn ends in a Stop, so the drop is prompt. It never fails the hook:
// a missing workspace id, bad JSON or an event it does not use is a quiet
// exit 0; anything else wrong goes to stderr.
//
// Nothing is fatal if an event is missed: a shell older than MAX_AGE_S is
// pruned on the next event, and the sidebar counts a shell only while the
// chat that started it is still open (src/shared/shells.ts).

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { scheduleBuild } from "../hook-build.ts";
import { type SavedShell, type State, validateState } from "../state-config.ts";
import { writeShells } from "../state-url.ts";
import { field } from "./gh-command.ts";
import { readTail } from "./transcript.ts";

type ShellMap = NonNullable<State["shells"]>;

/** A shell this old is taken as missed and dropped: longer than any real build or test run here. */
export const MAX_AGE_S = 12 * 60 * 60;

// The transcript tail a Stop reads. A notification lands in the turn that
// ends in this Stop, so it sits near the end.
const TAIL_BYTES = 512 * 1024;

// Claude Code's text when the tool result carries no backgroundTaskId.
const ID_IN_TEXT = /running in background with ID: ([\w-]+)/;

/** The task id of a Bash call that went to the background, or null for one that ran in the foreground. */
export function backgroundId(event: unknown): string | null {
  if (field(field(event, "tool_input"), "run_in_background") !== true) return null;
  const response = field(event, "tool_response");
  const id = field(response, "backgroundTaskId");
  if (typeof id === "string" && id) return id;
  const text = field(response, "stdout");
  return typeof text === "string" ? (ID_IN_TEXT.exec(text)?.[1] ?? null) : null;
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

function onBash(shells: SavedShell[], event: unknown, now: number): SavedShell[] {
  const id = backgroundId(event);
  const session = field(event, "session_id");
  if (id === null || typeof session !== "string" || shells.some((s) => s.id === id)) return shells;
  return [...shells, { id, session, startedEpoch: now }];
}

function onStop(shells: SavedShell[], finished: ReadonlySet<string>): SavedShell[] {
  return shells.some((s) => finished.has(s.id)) ? shells.filter((s) => !finished.has(s.id)) : shells;
}

/**
 * Folds one hook event into a workspace's shells. `finished` is what the
 * transcript says has ended, read only for a Stop. An event this hook does
 * not use is a no-op.
 */
export function applyEvent(
  map: ShellMap,
  wsId: string,
  event: unknown,
  now: number,
  finished: ReadonlySet<string> = new Set(),
): ShellMap {
  const shells = map[wsId] ?? [];
  const hookName = field(event, "hook_event_name");
  const next =
    hookName === "PostToolUse" ? onBash(shells, event, now) : hookName === "Stop" ? onStop(shells, finished) : shells;
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

/** Applies one event and prunes, then validates both sides as the write does, so a reshape is not taken for a change. */
export function processEvent(
  shells: ShellMap,
  wsId: string,
  event: unknown,
  now: number,
  finished?: ReadonlySet<string>,
): { after: ShellMap; changed: boolean } {
  const before = validateState({ shells }).shells ?? {};
  const after = validateState({ shells: prune(applyEvent(shells, wsId, event, now, finished), now) }).shells ?? {};
  return { after, changed: JSON.stringify(before) !== JSON.stringify(after) };
}

/** What a Stop's transcript says has finished; nothing for any other event or an unreadable file. */
function finishedFor(event: unknown): Set<string> {
  const path = field(event, "transcript_path");
  if (field(event, "hook_event_name") !== "Stop" || typeof path !== "string") return new Set();
  try {
    return finishedIds(readTail(path, TAIL_BYTES));
  } catch {
    return new Set();
  }
}

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
  const now = Math.floor(Date.now() / 1000);
  const finished = finishedFor(event);
  let changed = false;
  let result: ReturnType<typeof writeShells>;
  try {
    result = writeShells(STATE_PATH, (shells) => {
      const applied = processEvent(shells, wsId, event, now, finished);
      changed = applied.changed;
      return applied.after;
    });
  } catch (err) {
    console.error(`report-shell: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  if (!result.ok) return console.error(`report-shell: ${result.error}`);
  if (changed) scheduleBuild("report-shell");
}

if (import.meta.main) await main();
