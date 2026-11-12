// The `claude --bg` sessions a chat starts, for the background record
// (scripts/hooks/report-background.ts). Claude Code never lists them in
// `background_tasks`, so the record learns of one from the line
// `claude --bg` prints in a Bash call's output, and learns that it has
// settled from `claude agents --json` when the chat's turn ends.
//
// A session started by one of the chat's agents counts as the chat's: an
// agent's hooks carry the chat's session id, and the chat's Claude process.
//
// Each is saved as a task of type `session` whose id is ID_PREFIX and the
// short id `claude --bg` prints, so no id Claude Code gives its own tasks
// can match it. Everything here is pure but readSessionStates.

import { spawnSync } from "node:child_process";
import { cleanLabel, isId, isRecord, MAX_TASKS, type SavedTask, type State } from "../state-config.ts";
import { field } from "./gh-command.ts";

type BackgroundMap = NonNullable<State["background"]>;

/** Put before a session's short id to make its task id. */
export const ID_PREFIX = "bg:";

/**
 * How long a saved session may be missing from `claude agents --json`
 * before a settle drops it, from when it was saved: the read and a save
 * by one of the chat's agents can cross, and nothing says a session is
 * listed the moment `claude --bg` returns.
 */
export const GONE_GRACE_S = 60;

/** The longest the agents read may take before the settle gives up for this turn. */
const AGENTS_TIMEOUT_MS = 5000;

/** The chat that owns a session: its session id, and its Claude process when the hook was given one. */
export interface Owner {
  session: string;
  pid?: number;
}

/** One session a Bash call started: its short id and what to call it. */
export interface Launched {
  short: string;
  description: string;
}

/** Short id to state word, for every background session `claude agents --json` lists. */
export type SessionStates = ReadonlyMap<string, string>;

// `backgrounded · 68166394`, or with ` · <name>` after it, on a line of its
// own; a warning line can come first and four hint lines follow.
const LAUNCHED = /^backgrounded · ([0-9a-f]{8})(?: · ([^\n]*?))?[ \t]*\r?$/gm;

// `--bg` as a word of the command, so a call that only prints the line
// (a log, an issue comment) saves nothing.
const STARTS_BG = /(?:^|\s)--bg(?=\s|$)/;

/** Claude Code's words for a session that has finished; any other word counts as running, as the core reads it. */
const SETTLED: readonly string[] = ["done", "failed", "stopped"];

/** The text a Bash call printed, stdout and stderr both, since `claude --bg` may print to either. */
function printed(response: unknown): string {
  if (typeof response === "string") return response;
  return ["stdout", "stderr"]
    .map((k) => field(response, k))
    .filter((v): v is string => typeof v === "string")
    .join("\n");
}

/** The sessions a PostToolUse Bash call started, each once, or none for any other event. */
export function launchedSessions(event: unknown): Launched[] {
  if (field(event, "hook_event_name") !== "PostToolUse" || field(event, "tool_name") !== "Bash") return [];
  const command = field(field(event, "tool_input"), "command");
  if (typeof command !== "string" || !STARTS_BG.test(command)) return [];
  // The Bash call's own description, never the command, which can carry a
  // token or a key that has no place in the record or on the card.
  const fallback = cleanLabel(field(field(event, "tool_input"), "description")) ?? "claude --bg";
  const found = new Map<string, Launched>();
  for (const [, short, name] of printed(field(event, "tool_response")).matchAll(LAUNCHED)) {
    if (short === undefined || found.has(short)) continue;
    found.set(short, { short, description: cleanLabel(name) ?? fallback });
  }
  return [...found.values()];
}

/** The chat an event belongs to, or null without a session id to save under. */
export function ownerOf(event: unknown, pid?: number): Owner | null {
  const session = field(event, "session_id");
  if (typeof session !== "string" || !isId(session)) return null;
  return pid === undefined ? { session } : { session, pid };
}

/** A saved session the chat owns: saved under its session, or by its Claude process before a /clear. */
const owns = (owner: Owner, t: SavedTask): boolean =>
  t.type === "session" && (t.session === owner.session || (owner.pid !== undefined && t.pid === owner.pid));

/** Whether the chat has any session saved in the workspace, so a settle is worth the agents read. */
export const ownsSessions = (map: BackgroundMap, wsId: string, owner: Owner): boolean =>
  (map[wsId] ?? []).some((t) => owns(owner, t));

/**
 * Saves each session as a running `session` task of the chat's. One saved
 * already is restamped in place, keeping its start. A new one goes last,
 * unless the workspace holds MAX_TASKS already: then it is left out, so
 * the validators' cut never drops another entry on a hook write.
 */
export function saveLaunched(
  map: BackgroundMap,
  wsId: string,
  owner: Owner,
  launched: readonly Launched[],
  now: number,
): BackgroundMap {
  const tasks = [...(map[wsId] ?? [])];
  for (const { short, description } of launched) {
    const id = ID_PREFIX + short;
    const at = tasks.findIndex((t) => t.id === id);
    const entry: SavedTask = {
      id,
      type: "session",
      status: "running",
      description,
      session: owner.session,
      ...(owner.pid === undefined ? {} : { pid: owner.pid }),
      startedEpoch: tasks[at]?.startedEpoch ?? now,
      seenEpoch: now,
    };
    if (at >= 0) tasks[at] = entry;
    else if (tasks.length < MAX_TASKS) tasks.push(entry);
  }
  return tasks.length ? { ...map, [wsId]: tasks } : map;
}

/** What `claude agents --json` printed, read to states, or null when it is not a list. */
export function sessionStates(text: string): SessionStates | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const states = new Map<string, string>();
  for (const a of parsed) {
    if (!isRecord(a) || a.kind !== "background" || typeof a.id !== "string" || a.id === "") continue;
    states.set(a.id, typeof a.state === "string" ? a.state : "");
  }
  return states;
}

/** The chat's sessions as `claude agents --json` reads now, or null when the read fails or times out. */
export function readSessionStates(): SessionStates | null {
  const res = spawnSync("claude", ["agents", "--json"], { encoding: "utf8", timeout: AGENTS_TIMEOUT_MS });
  if (res.error !== undefined || res.status !== 0) return null;
  return sessionStates(res.stdout);
}

/** One owned session after a settle: kept and restamped while it runs, dropped once settled or long gone. */
function settled(t: SavedTask, states: SessionStates, now: number): SavedTask[] {
  if (!t.id.startsWith(ID_PREFIX)) return [t];
  const state = states.get(t.id.slice(ID_PREFIX.length));
  if (state === undefined) return now - t.startedEpoch < GONE_GRACE_S ? [t] : [];
  return SETTLED.includes(state) ? [] : [{ ...t, seenEpoch: now }];
}

/**
 * Settles the chat's sessions in a workspace against `states`: one still
 * running (working, blocked or a word Claude Code adds later) gets a new
 * seenEpoch, so the prune keeps it; one done, failed or stopped, or gone
 * from the list for GONE_GRACE_S, is dropped. Every other entry is left.
 */
export function settle(
  map: BackgroundMap,
  wsId: string,
  owner: Owner,
  states: SessionStates,
  now: number,
): BackgroundMap {
  const saved = map[wsId];
  if (saved === undefined) return map;
  const next = saved.flatMap((t) => (owns(owner, t) ? settled(t, states, now) : [t]));
  const { [wsId]: _, ...rest } = map;
  return next.length ? { ...rest, [wsId]: next } : rest;
}
