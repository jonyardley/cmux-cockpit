// The pure parts of the URL handler (docs/state-loop.md): parsing a
// cmux-cockpit:// URL into a {key, value} pair, and the read-apply-write
// step against config/state.json. Kept apart from state-set.ts so both can
// be tested without a subprocess, and the file step against a temp dir.
//
// Every URL is untrusted input: parsing never throws, an unrecognised shape
// is refused rather than guessed at, and error messages never echo it raw.

import { closeSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { applySet, type SetResult, type State, validateState } from "./state-config.ts";

export type ParsedSet = { ok: true; key: string; value: string | null } | { ok: false; error: string };

// The only query params the URL is allowed to carry.
const ALLOWED_PARAMS = new Set(["key", "value"]);

/** Parses `cmux-cockpit://set?key=<map>.<wsId>&value=<json>` (value absent = delete). */
export function parseSetUrl(raw: string): ParsedSet {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, error: "not a URL" };
  }
  if (url.protocol !== "cmux-cockpit:") return { ok: false, error: `wrong protocol ${JSON.stringify(url.protocol)}` };
  if (url.host !== "set") return { ok: false, error: `wrong host ${JSON.stringify(url.host)}` };
  if (url.pathname !== "" && url.pathname !== "/") return { ok: false, error: "unexpected path" };
  for (const param of url.searchParams.keys()) {
    if (!ALLOWED_PARAMS.has(param)) return { ok: false, error: `unknown param ${JSON.stringify(param)}` };
  }
  const key = url.searchParams.get("key");
  if (!key) return { ok: false, error: "missing key" };
  return { ok: true, key, value: url.searchParams.get("value") };
}

export type ApplyResult = { ok: true; changed: boolean } | { ok: false; error: string };

const LOCK_WAIT_MS = 2000;
const LOCK_STALE_MS = 10_000;
const sleep = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

// An exclusive lockfile, so two handler runs cannot both read the old state
// and lose one write. A lock older than LOCK_STALE_MS is a crashed run's.
function withLock<T>(path: string, fn: () => T): T {
  const lock = `${path}.lock`;
  for (let waited = 0; ; waited += 20) {
    try {
      closeSync(openSync(lock, "wx"));
      break;
    } catch {
      const age = Date.now() - (statSync(lock, { throwIfNoEntry: false })?.mtimeMs ?? Date.now());
      if (age > LOCK_STALE_MS) rmSync(lock, { force: true });
      else if (waited >= LOCK_WAIT_MS) throw new Error("state file is locked");
      else sleep(20);
    }
  }
  try {
    return fn();
  } finally {
    rmSync(lock, { force: true });
  }
}

function readState(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

const serialise = (state: unknown): string => `${JSON.stringify(state, null, 2)}\n`;

/**
 * A map with its keys sorted, so replacing it with the same entries in a
 * different order (a reorder of workspaces or windows between polls, say)
 * is never seen as a change. Shared by writePrs and writeSubagents.
 */
function sortedByKey<T>(map: Record<string, T>): Record<string, T> {
  return Object.fromEntries(
    Object.keys(map)
      .sort()
      .map((id) => [id, map[id] as T]),
  );
}

/**
 * Reads the state file, applies one set, and writes it back atomically
 * (a unique temp file then rename), under a lock. A missing or unparseable
 * file reads as empty state, per the contract; a refused set leaves the file
 * untouched. `changed` is false when the set made no difference, so the
 * caller can skip a rebuild. Throws only on a filesystem failure.
 */
export function readApplyWrite(path: string, key: string, value: string | null): ApplyResult {
  return readUpdateWrite(path, (before) => applySet(before, key, value));
}

/**
 * Replaces the whole `prs` map (scripts/pr-poll.ts), the same way
 * readApplyWrite applies one set. Keys are sorted before writing, so a
 * reorder of workspaces or windows between polls is not seen as a change.
 */
export function writePrs(path: string, prs: State["prs"]): ApplyResult {
  const sorted = sortedByKey(prs);
  return readUpdateWrite(path, (before) => ({ ok: true, state: validateState({ ...before, prs: sorted }) }));
}

/** Replaces the whole `ownPrs` map (scripts/pr-poll.ts), keys sorted, as writePrs does. */
export function writeOwnPrs(path: string, ownPrs: State["ownPrs"]): ApplyResult {
  const sorted = sortedByKey(ownPrs);
  return readUpdateWrite(path, (before) => ({ ok: true, state: validateState({ ...before, ownPrs: sorted }) }));
}

/**
 * Folds `update` over the whole `subagents` map (scripts/hooks/report-subagent.ts),
 * the same locked read-modify-write step writePrs uses for its map. `update`
 * gets the current map and returns the next one; keys are sorted before
 * writing, so touching one workspace never shows as a change to another's
 * position in the file.
 */
export function writeSubagents(
  path: string,
  update: (subagents: State["subagents"]) => State["subagents"],
): ApplyResult {
  return readUpdateWrite(path, (before) => {
    const next = update(before.subagents);
    const sorted = sortedByKey(next);
    return { ok: true, state: validateState({ ...before, subagents: sorted }) };
  });
}

function readUpdateWrite(path: string, update: (before: State) => SetResult): ApplyResult {
  mkdirSync(dirname(path), { recursive: true });
  return withLock(path, () => {
    const before = validateState(readState(path));
    const result = update(before);
    if (!result.ok) return result;
    const text = serialise(result.state);
    if (text === serialise(before)) return { ok: true, changed: false };

    const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    writeFileSync(tmp, text);
    renameSync(tmp, path);
    return { ok: true, changed: true };
  });
}
