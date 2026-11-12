// Records the background work each workspace's chats have running: shells,
// monitors, background agents and their own work, as Claude Code lists it.
// cmux sends custom sidebars none of this, so this hook is the only source.
//
// Run by scripts/hooks/dispatch.ts on Stop, SubagentStop and PostToolUse
// Bash, as scripts/hooks/routes.ts lists them; the Bash call and the Stop
// settle are for `claude --bg` sessions (scripts/hooks/bg-sessions.ts). Both carry `background_tasks`, a full
// snapshot of the chat's work in flight (SubagentStop's is the parent
// chat's, under the chat's session id): a finished task drops out of the
// list rather than changing its status. So each snapshot replaces, in
// place, the entries its chat saved (under its session, or by its Claude
// process before a /clear), keeping a task's place and startedEpoch while
// it stays listed. It never fails the hook: a missing workspace id,
// bad JSON or an event with no list is a quiet exit 0; anything else wrong
// goes to stderr.
//
// What a snapshot cannot say, and how a missed end is caught instead:
// - A monitor is listed as `shell`, so a monitor's own deadline cannot end
//   it; it ends with the list like any shell.
// - A `claude --bg` session is never listed. Its entries (type `session`,
//   saved from the Bash call that started it) are kept through every
//   replace, but pruned like any other entry, so the chat's Stop restamps
//   seenEpoch while `claude agents --json` says the session runs, and
//   drops it once that says it has settled.
// - After a `/clear` the chat lists under a new session id, but from the
//   same Claude process, so a snapshot also replaces the entries saved by
//   its process (CLAUDE_PID, which Claude Code sets for every hook it runs).
// - The chat's process gone ends its work: the core counts a task only
//   while the chat owning its session (native/core/src/owner.rs) is open
//   (native/core/src/background.rs).
// - Anything a snapshot has not listed for MAX_AGE_S is pruned on the next
//   write, for a chat whose last Stop never came.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { scheduleBuild } from "../hook-build.ts";
import {
  cleanLabel,
  isId,
  isPid,
  isRecord,
  MAX_STATUS,
  MAX_TASKS,
  type SavedTask,
  type State,
  taskType,
  validateState,
} from "../state-config.ts";
import { writeBackground } from "../state-url.ts";
import {
  launchedSessions,
  ownerOf,
  ownsSessions,
  readSessionStates,
  type SessionStates,
  saveLaunched,
  settle,
} from "./bg-sessions.ts";
import { field } from "./gh-command.ts";
import { MAX_AGE_S } from "./report-shell.ts";

type BackgroundMap = NonNullable<State["background"]>;

/** One task as a snapshot lists it, before it is stamped and saved. */
export type ListedTask = Pick<SavedTask, "id" | "type" | "status" | "description">;

/** One Stop or SubagentStop's list, with the chat session and Claude process that listed it. */
export interface Snapshot {
  session: string;
  /** The Claude process's id (CLAUDE_PID), when the hook was given one. */
  pid?: number;
  listed: ListedTask[];
}

const LISTING_EVENTS: readonly unknown[] = ["Stop", "SubagentStop"];

/**
 * Claude Code's words for a task that has ended (its status set is
 * pending, running, completed, failed, killed and paused). Only `running`
 * has been seen in a list, since an ended task leaves it, but one listed
 * with these words is not running work.
 */
const ENDED: readonly unknown[] = ["completed", "failed", "killed"];

const hasEnded = (t: ListedTask): boolean => ENDED.includes(t.status);

function listedTask(v: unknown): ListedTask[] {
  if (!isRecord(v) || typeof v.id !== "string" || !isId(v.id)) return [];
  const status = cleanLabel(v.status);
  // `session` is this cockpit's word for a `claude --bg` session, which
  // only the later hook saves and every replace keeps; a listed task
  // calling itself that would never leave with the list.
  const type = v.type === "session" ? "other" : taskType(v.type);
  return [
    {
      id: v.id,
      type,
      status: status !== null && status.length <= MAX_STATUS ? status : "running",
      description: cleanLabel(v.description) ?? type,
    },
  ];
}

/** The first of each id, so a task listed twice is saved once. */
function firstOfEach(tasks: readonly ListedTask[]): ListedTask[] {
  const seen = new Set<string>();
  return tasks.filter((t) => {
    if (seen.has(t.id)) return false;
    seen.add(t.id);
    return true;
  });
}

/**
 * The tasks a Stop or SubagentStop lists, or null for any other event, or
 * one without a list: Claude Code leaves it out when its task registry is
 * unreachable, which says nothing about what is running. An entry that
 * cannot be read is dropped on its own. One that says it has ended is
 * kept here, so it still takes out a saved copy, and is never saved.
 */
export function listedTasks(event: unknown): ListedTask[] | null {
  if (!LISTING_EVENTS.includes(field(event, "hook_event_name"))) return null;
  const list = field(event, "background_tasks");
  return Array.isArray(list) ? firstOfEach(list.flatMap(listedTask)) : null;
}

/** The pid a hook was given as text (CLAUDE_PID), or undefined when it is missing or not one. */
export function pidFrom(text: string | undefined): number | undefined {
  const pid = text && /^\d+$/.test(text) ? Number(text) : undefined;
  return isPid(pid) ? pid : undefined;
}

/** The snapshot an event carries, or null when it has no list or no session to save it under. */
export function snapshotOf(event: unknown, pid?: number): Snapshot | null {
  const listed = listedTasks(event);
  const session = field(event, "session_id");
  if (listed === null || typeof session !== "string" || !isId(session)) return null;
  return pid === undefined ? { session, listed } : { session, pid, listed };
}

/**
 * Whether `snap` replaces a saved task: one saved under its session, or by
 * its Claude process (the same chat before a /clear), or one it lists (a
 * task saved under another session moves to this one). A `session` entry
 * is never replaced, since no list holds it.
 */
function replaces(snap: Snapshot, listedIds: ReadonlySet<string>, t: SavedTask): boolean {
  if (t.type === "session") return false;
  const sameProcess = snap.pid !== undefined && t.pid === snap.pid;
  return t.session === snap.session || sameProcess || listedIds.has(t.id);
}

/**
 * Replaces the entries `snap` owns in a workspace (see `replaces`) with
 * its list, in place, so the order is stable: a task already saved keeps
 * its place and startedEpoch, and a new one goes last. Other chats'
 * entries and `session` entries are never pushed out: when the workspace
 * would pass MAX_TASKS, this chat's newest tasks are the ones left out.
 */
export function applySnapshot(map: BackgroundMap, wsId: string, snap: Snapshot, now: number): BackgroundMap {
  const saved = map[wsId] ?? [];
  const listedIds = new Set(snap.listed.map((t) => t.id));
  const others = saved.filter((t) => !replaces(snap, listedIds, t));
  let room = MAX_TASKS - others.length;
  const stamp = (t: ListedTask, before?: SavedTask): SavedTask => ({
    ...t,
    session: snap.session,
    ...(snap.pid === undefined ? {} : { pid: snap.pid }),
    startedEpoch: before?.startedEpoch ?? now,
    seenEpoch: now,
  });
  const byId = new Map(snap.listed.filter((t) => !hasEnded(t)).map((t) => [t.id, t]));
  const next: SavedTask[] = [];
  for (const t of saved) {
    const listed = byId.get(t.id);
    if (!replaces(snap, listedIds, t)) next.push(t);
    else if (listed && room > 0) {
      next.push(stamp(listed, t));
      byId.delete(t.id);
      room--;
    }
  }
  next.push(...[...byId.values()].slice(0, Math.max(room, 0)).map((t) => stamp(t)));
  const { [wsId]: _, ...rest } = map;
  return next.length ? { ...rest, [wsId]: next } : rest;
}

/**
 * Drops tasks no snapshot has listed for MAX_AGE_S across every workspace,
 * and any workspace left with none. `session` entries too: the hook that
 * saves them restamps seenEpoch while the session runs.
 */
export function prune(map: BackgroundMap, now: number): BackgroundMap {
  const out: BackgroundMap = {};
  for (const [wsId, tasks] of Object.entries(map)) {
    const kept = tasks.filter((t) => now - t.seenEpoch <= MAX_AGE_S);
    if (kept.length) out[wsId] = kept;
  }
  return out;
}

/**
 * The map as text without the seenEpoch stamps, workspaces in key order as
 * the write sorts them, so a write that only restamps tasks asks for no build.
 */
export const unstamped = (map: BackgroundMap): string =>
  JSON.stringify(
    Object.keys(map)
      .sort()
      .map((wsId) => [wsId, map[wsId]]),
    (key, value: unknown) => (key === "seenEpoch" ? undefined : value),
  );

/** One snapshot folded in, then the prune: what the hook writes. */
const fold = (map: BackgroundMap, wsId: string, snap: Snapshot, now: number): BackgroundMap =>
  prune(applySnapshot(map, wsId, snap, now), now);

/** One event folded in, as `main` folds it once it has read the snapshot. */
export function update(map: BackgroundMap, wsId: string, event: unknown, now: number, pid?: number): BackgroundMap {
  const snap = snapshotOf(event, pid);
  return snap ? fold(map, wsId, snap, now) : map;
}

/** What `foldFor` may read beyond the event: the record as it stands, and what `claude agents --json` says. */
export interface Reads {
  saved: () => BackgroundMap;
  states: () => SessionStates | null;
}

/**
 * What one event does to the record, as a fold for the locked write, or
 * null for nothing. A PostToolUse Bash call that started `claude --bg`
 * sessions saves them (scripts/hooks/bg-sessions.ts). A Stop or
 * SubagentStop applies its list. A chat's own Stop first settles the
 * `session` entries it owns, but reads `claude agents --json` only when
 * it owns one, and before the lock; a failed read settles nothing. The
 * settle comes before the prune, so a session still running is never
 * pruned for want of a list that cannot hold it.
 */
export function foldFor(
  event: unknown,
  wsId: string,
  now: number,
  reads: Reads,
  pid?: number,
): ((map: BackgroundMap) => BackgroundMap) | null {
  const owner = ownerOf(event, pid);
  if (owner === null) return null;
  const launched = launchedSessions(event);
  if (launched.length) return (map) => prune(saveLaunched(map, wsId, owner, launched, now), now);
  const snap = snapshotOf(event, pid);
  const isStop = field(event, "hook_event_name") === "Stop";
  const states = isStop && ownsSessions(reads.saved(), wsId, owner) ? reads.states() : null;
  if (snap === null && states === null) return null;
  return (map) => {
    const settledMap = states === null ? map : settle(map, wsId, owner, states, now);
    return prune(snap === null ? settledMap : applySnapshot(settledMap, wsId, snap, now), now);
  };
}

const ROOT = join(import.meta.dirname, "..", "..");
const STATE_PATH = join(ROOT, "config", "state.json");

/** The record as it stands, read without the lock, or none when the file cannot be read. */
function peek(): BackgroundMap {
  try {
    return validateState(JSON.parse(readFileSync(STATE_PATH, "utf8"))).background ?? {};
  } catch {
    return {};
  }
}

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
  const reads: Reads = { saved: peek, states: readSessionStates };
  const apply = foldFor(event, wsId, now, reads, pidFrom(process.env.CLAUDE_PID));
  if (apply === null) return;
  let moved = false;
  let result: ReturnType<typeof writeBackground>;
  try {
    result = writeBackground(STATE_PATH, (map) => {
      const next = apply(map);
      moved = unstamped(next) !== unstamped(map);
      return next;
    });
  } catch (err) {
    console.error(`report-background: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  if (!result.ok) return console.error(`report-background: ${result.error}`);
  if (result.changed && moved) scheduleBuild("report-background");
}

if (import.meta.main) await main();
