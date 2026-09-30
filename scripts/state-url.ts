// The pure parts of the URL handler (docs/state-loop.md): parsing a
// cmux-cockpit:// URL into a {key, value} pair, and the read-apply-write
// step against config/state.json. Kept apart from state-set.ts so both can
// be tested without a subprocess, and the file step against a temp dir.
//
// Every URL is untrusted input: parsing never throws, an unrecognised shape
// is refused rather than guessed at, and error messages never echo it raw.
// Any web page can open one, so a set must also carry this install's token
// (config/url-token, baked into the sidebars by build.ts): a page cannot
// read the file, so it cannot forge a set.

import { randomBytes, timingSafeEqual } from "node:crypto";
import {
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { pauseSync, tryTakeLock, waitForLock } from "./lockfile.ts";
import { applySet, isRecord, type SavedPoll, type SetResult, type State, validateState } from "./state-config.ts";

// `token` is left out, rather than null, when the URL carries none.
export type ParsedSet = { ok: true; key: string; value: string | null; token?: string } | { ok: false; error: string };

// The only query params the URL is allowed to carry.
const ALLOWED_PARAMS = new Set(["key", "value", "token"]);

/**
 * Parses `cmux-cockpit://set?key=<map>.<wsId>&value=<json>&token=<token>`
 * (value absent = delete). The token is only read here; tokenMatches
 * checks it.
 */
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
  const token = url.searchParams.get("token");
  return { ok: true, key, value: url.searchParams.get("value"), ...(token === null ? {} : { token }) };
}

/**
 * True when `given` is this install's token. A missing or empty token on
 * either side never matches. Compared in constant time (after the length
 * check timingSafeEqual needs), so a page probing tokens learns nothing
 * from how long a refusal takes.
 */
export function tokenMatches(given: string | undefined, expected: string | null): boolean {
  if (!given || !expected) return false;
  const a = Buffer.from(given, "utf8");
  const b = Buffer.from(expected, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

/** The token file's contents, trimmed, or null when it is missing, unreadable or empty. */
export function readUrlToken(path: string): string | null {
  try {
    return readFileSync(path, "utf8").trim() || null;
  } catch {
    return null;
  }
}

const isCode = (err: unknown, code: string): boolean => err instanceof Error && "code" in err && err.code === code;

const newToken = (): string => `${randomBytes(32).toString("hex")}\n`;

/**
 * The token at `path`, created first (32 random bytes as hex, readable by
 * this user only) when there is none. Created exclusively, so two builds
 * at once agree on one token. An empty file (a first build cut off before
 * the bytes landed) is replaced with a fresh token rather than failing
 * every build after it; nothing can hold the old one, since it was empty.
 * Throws when the file cannot be made or read.
 */
export function ensureUrlToken(path: string): string {
  mkdirSync(dirname(path), { recursive: true });
  try {
    writeFileSync(path, newToken(), { flag: "wx", mode: 0o600 });
  } catch (err) {
    if (!isCode(err, "EEXIST")) throw err;
  }
  if (readUrlToken(path) === null && readFileSync(path, "utf8").trim() === "") {
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, newToken(), { mode: 0o600 });
    renameSync(tmp, path);
  }
  const token = readUrlToken(path);
  if (token === null) throw new Error(`${path} is empty or unreadable`);
  return token;
}

export type ApplyResult = { ok: true; changed: boolean } | { ok: false; error: string };

const LOCK_WAIT_MS = 2000;
const LOCK_STALE_MS = 10_000;

// An exclusive lockfile, so two handler runs cannot both read the old state
// and lose one write. A lock older than LOCK_STALE_MS is a crashed run's.
function withLock<T>(path: string, fn: () => T): T {
  const lock = `${path}.lock`;
  if (!waitForLock(() => tryTakeLock(lock, LOCK_STALE_MS), LOCK_WAIT_MS, pauseSync, 20)) {
    throw new Error("state file is locked");
  }
  try {
    return fn();
  } finally {
    rmSync(lock, { force: true });
  }
}

/** Where an unreadable state file is kept aside (build.ts reads it too). */
export const unreadableCopyOf = (path: string): string => `${path}.unreadable.bak`;

/**
 * Copies `path` to unreadableCopyOf(path), never over an earlier copy:
 * the first broken file is the one that held the saved state. Returns
 * false when a copy was already there; throws on any other failure.
 */
export function keepUnreadableCopy(path: string): boolean {
  try {
    copyFileSync(path, unreadableCopyOf(path), constants.COPYFILE_EXCL);
    return true;
  } catch (err) {
    if (isCode(err, "EEXIST")) return false;
    throw err;
  }
}

// Before a write replaces a broken file: the usual copy, or, when an
// earlier copy is already there and holds something else, a second one
// named for the time, so a later breakage is not lost either. Only the
// writes do this, once per broken file, since they replace it; the build
// keeps the one copy, as it runs again and again on the same file.
function keepBeforeReplacing(path: string): void {
  if (keepUnreadableCopy(path)) return;
  if (readFileSync(path).equals(readFileSync(unreadableCopyOf(path)))) return;
  copyFileSync(path, `${path}.unreadable.${Date.now()}.bak`, constants.COPYFILE_EXCL);
}

// The file's contents, and whether it is there but broken: it does not
// parse, or is not a JSON object, which is what build.ts flags as
// unreadable. A missing file is a clean start, not broken.
function readState(path: string): { value: unknown; broken: boolean } {
  if (!existsSync(path)) return { value: undefined, broken: false };
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    return { value, broken: !isRecord(value) };
  } catch {
    return { value: undefined, broken: true };
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
 * file reads as empty state, per the contract, and an unparseable one is
 * copied aside first (keepBeforeReplacing); a refused set leaves the file
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

/**
 * Keeps a Keep (State.mergeKept) only while the workspace's saved PR is the
 * one kept, so closed workspaces and later PRs do not leave entries behind.
 */
function keptStill(before: State, prs: State["prs"]): State["mergeKept"] {
  return Object.fromEntries(
    Object.entries(before.mergeKept).filter(([id, n]) => Object.hasOwn(prs, id) && prs[id]?.number === n),
  );
}

/**
 * One poll's whole write (scripts/pr-poll.ts) in a single locked pass:
 * replaces the `prs` and `ownPrs` maps, keys sorted as writePrs does,
 * folds `subagents` over the `subagents` map and prunes `mergeKept`
 * (keptStill), so the file is never left half updated. `poll` (#78) is the
 * saved poll status in the same pass: replaced when given, removed when
 * null, kept as it was when left out.
 */
export function writePollMaps(
  path: string,
  prs: State["prs"],
  ownPrs: State["ownPrs"],
  subagents: (runs: State["subagents"]) => State["subagents"],
  poll?: SavedPoll | null,
): ApplyResult {
  return readUpdateWrite(path, (before) => {
    const next: State = {
      ...before,
      prs: sortedByKey(prs),
      ownPrs: sortedByKey(ownPrs),
      mergeKept: keptStill(before, prs),
      ...(poll ? { poll } : {}),
    };
    if (poll === null) delete next.poll;
    return { ok: true, state: validateState({ ...next, subagents: sortedByKey(subagents(before.subagents)) }) };
  });
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

/**
 * Folds `update` over the whole `published` map
 * (scripts/hooks/report-published.ts), under the same lock. Keys are not
 * sorted: the map is kept oldest first, so validateState's cap drops the
 * oldest entries rather than whichever URLs sort first.
 */
export function writePublished(
  path: string,
  update: (published: State["published"]) => State["published"],
): ApplyResult {
  return readUpdateWrite(path, (before) => ({
    ok: true,
    state: validateState({ ...before, published: update(before.published) }),
  }));
}

/**
 * Folds `update` over the whole `prOrigins` map (scripts/hooks/report-pr.ts),
 * under the same lock, kept oldest first as
 * writePublished keeps its map.
 */
export function writePrOrigins(path: string, update: (origins: State["prOrigins"]) => State["prOrigins"]): ApplyResult {
  return readUpdateWrite(path, (before) => ({
    ok: true,
    state: validateState({ ...before, prOrigins: update(before.prOrigins) }),
  }));
}

function readUpdateWrite(path: string, update: (before: State) => SetResult): ApplyResult {
  mkdirSync(dirname(path), { recursive: true });
  return withLock(path, () => {
    const read = readState(path);
    const before = validateState(read.value);
    const result = update(before);
    if (!result.ok) return result;
    const text = serialise(result.state);
    if (text === serialise(before)) return { ok: true, changed: false };

    // A broken file is kept aside before the replacement lands, or this
    // write would overwrite it before a build ever saw it to back it up
    // (#78). A failed copy throws, so the write is abandoned and the
    // broken file kept.
    if (read.broken) keepBeforeReplacing(path);
    const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    writeFileSync(tmp, text);
    renameSync(tmp, path);
    return { ok: true, changed: true };
  });
}
