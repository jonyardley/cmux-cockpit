// Records the background work each workspace's chats have running: shells,
// monitors, background agents and their own work, as Claude Code lists it.
// cmux sends custom sidebars none of this, so this hook is the only source.
//
// Run by scripts/hooks/dispatch.ts on Stop and SubagentStop, as
// scripts/hooks/routes.ts lists them. Both carry `background_tasks`, a full
// snapshot of the chat's work in flight (SubagentStop's is the parent
// chat's, under the chat's session id): a finished task drops out of the
// list rather than changing its status. So each snapshot replaces the
// entries saved under its session wholesale, keeping a task's startedEpoch
// while it stays listed. It never fails the hook: a missing workspace id,
// bad JSON or an event with no list is a quiet exit 0; anything else wrong
// goes to stderr.
//
// What a snapshot cannot say, and how a missed end is caught instead:
// - A monitor is listed as `shell`, so a monitor's own deadline cannot end
//   it; it ends with the list like any shell.
// - A `claude --bg` session is never listed. Its entries (type `session`,
//   saved by a later hook) are kept through every replace.
// - The chat's process gone ends its work: the core counts a task only
//   while the chat owning its session (native/core/src/owner.rs) is open
//   (native/core/src/background.rs).
// - Anything a snapshot has not listed for MAX_AGE_S is pruned on the next
//   write, for a chat whose last Stop never came.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { scheduleBuild } from "../hook-build.ts";
import { cleanLabel, isId, isRecord, MAX_STATUS, type SavedTask, type State, taskType } from "../state-config.ts";
import { writeBackground } from "../state-url.ts";
import { field } from "./gh-command.ts";

type BackgroundMap = NonNullable<State["background"]>;

/** One task as a snapshot lists it, before it is stamped and saved. */
export type ListedTask = Pick<SavedTask, "id" | "type" | "status" | "description">;

/** A task no snapshot has listed for this long is taken as missed and dropped. */
export const MAX_AGE_S = 12 * 60 * 60;

const LISTING_EVENTS: readonly unknown[] = ["Stop", "SubagentStop"];

function listedTask(v: unknown): ListedTask[] {
  if (!isRecord(v) || typeof v.id !== "string" || !isId(v.id)) return [];
  const type = taskType(v.type);
  const status = cleanLabel(v.status);
  return [
    {
      id: v.id,
      type,
      status: status !== null && status.length <= MAX_STATUS ? status : "running",
      description: cleanLabel(v.description) ?? type,
    },
  ];
}

/**
 * The tasks a Stop or SubagentStop lists, or null for any other event, or
 * one without a list: Claude Code leaves it out when its task registry is
 * unreachable, which says nothing about what is running. An entry that
 * cannot be read is dropped on its own.
 */
export function listedTasks(event: unknown): ListedTask[] | null {
  if (!LISTING_EVENTS.includes(field(event, "hook_event_name"))) return null;
  const list = field(event, "background_tasks");
  return Array.isArray(list) ? list.flatMap(listedTask) : null;
}

/**
 * Replaces the entries `session` saved in a workspace with `listed`. A
 * task listed under another session too (the same chat after a /clear)
 * moves to this one. `session` entries, which no list holds, are kept.
 */
export function applySnapshot(
  map: BackgroundMap,
  wsId: string,
  session: string,
  listed: readonly ListedTask[],
  now: number,
): BackgroundMap {
  const saved = map[wsId] ?? [];
  const ids = new Set(listed.map((t) => t.id));
  const kept = saved.filter((t) => t.type === "session" || (t.session !== session && !ids.has(t.id)));
  const fresh = listed.map((t): SavedTask => {
    const before = saved.find((s) => s.id === t.id && s.type !== "session");
    return { ...t, session, startedEpoch: before?.startedEpoch ?? now, seenEpoch: now };
  });
  const next = [...kept, ...fresh];
  const { [wsId]: _, ...rest } = map;
  return next.length ? { ...rest, [wsId]: next } : rest;
}

/** Drops tasks no snapshot has listed for MAX_AGE_S across every workspace, and any workspace left with none. */
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

/** One event folded in, then the prune: what the hook writes. */
export function update(map: BackgroundMap, wsId: string, event: unknown, now: number): BackgroundMap {
  const listed = listedTasks(event);
  const session = field(event, "session_id");
  if (listed === null || typeof session !== "string" || !isId(session)) return map;
  return prune(applySnapshot(map, wsId, session, listed, now), now);
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
  if (listedTasks(event) === null) return;
  const now = Math.floor(Date.now() / 1000);
  let moved = false;
  let result: ReturnType<typeof writeBackground>;
  try {
    result = writeBackground(STATE_PATH, (map) => {
      const next = update(map, wsId, event, now);
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
