// The coalesced rebuild the state hooks share (docs/state-loop.md):
// scripts/hooks/report-subagent.ts, report-published.ts and
// report-notification.ts (#81) each write config/state.json, and the
// sidebars only see a write once scripts/build.ts bakes it in. Moved here
// from report-subagent.ts (#52) so every hook uses one lock and one build.
//
// Rebuilding both sidebars costs a full esbuild pass, so two events close
// together (SubagentStart fires ~25ms after the PreToolUse that starts the
// same run, and independent subagents can start together) should not each
// spawn their own build. This coalesces them with a lockfile in config/:
// the first event to see no build in flight takes the lock and spawns a
// detached run of this file with --coalesce-build, which sleeps briefly (so
// a near-simultaneous second write lands before the build reads the file),
// runs scripts/build.ts, and only then drops the lock; every other event in
// that window sees the lock held and does nothing, trusting the build that
// holds it to pick up its write once it runs. A lock older than
// BUILD_LOCK_STALE_MS is a crashed build's and is retaken.
//
// Every build of the sidebars from a state write goes through this lock,
// so two builds never run at once and an older bundle can never land after
// a newer one. scheduleBuild is the detached, fire-and-forget path (the
// hooks and scripts/state-set.ts); buildNow is the synchronous one for a
// caller that needs the result (scripts/pr-poll.ts, which rolls its write
// back when the build fails): it waits briefly for the lock instead of
// skipping. Whoever holds the lock looks at the build's inputs (the state
// file, config/projects.json and every file under src/) again after
// dropping it, so neither a write that skipped its own build nor a source
// change that landed mid-build is left unbuilt.
//
// `npm run build` runs this file with --locked (lockedBuild): it waits for
// the same lock, for as long as a live build could hold it, then builds
// with the output shown, so a git hook's rebuild, the close-out's and the
// check's never race a tap's or a poll's either. Everything that holds the
// lock spawns scripts/build.ts directly, never `npm run build`, so nothing
// waits on a lock it holds itself.

import { spawn, spawnSync } from "node:child_process";
import { closeSync, openSync, readdirSync, readFileSync, rmSync, statSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { pauseSync, tryTakeLock, waitForLock } from "./lockfile.ts";
import { LOG_PATH } from "./state-log.ts";

const ROOT = join(import.meta.dirname, "..");
const BUILD_LOCK = join(ROOT, "config", "hook-build.lock");
// Exported so a test can check the stale threshold sits comfortably above
// this delay plus the timeout, without duplicating the figures.
export const COALESCE_MS = 300;
export const BUILD_TIMEOUT_MS = 60_000;
// Comfortably above the coalesce delay plus how long one build pass may
// run (2x the timeout). A holder touches the lock before every pass, so a
// build that is genuinely still going, however many passes it takes for
// writes that landed mid-build, is never mistaken for a crashed one's and
// retaken out from under it.
export const BUILD_LOCK_STALE_MS = 2 * BUILD_TIMEOUT_MS;

function logFd(): number | "ignore" {
  try {
    return openSync(LOG_PATH, "a");
  } catch {
    return "ignore";
  }
}

const tryTakeBuildLock = (): boolean => tryTakeLock(BUILD_LOCK, BUILD_LOCK_STALE_MS);
const releaseBuildLock = (): void => rmSync(BUILD_LOCK, { force: true });

// Marks the held lock as live before each build pass, so a holder that
// builds several passes in a row (writes kept landing) is never taken for
// a crashed one: the lock is at most one build's timeout old while live.
function touchBuildLock(): void {
  try {
    const now = new Date();
    utimesSync(BUILD_LOCK, now, now);
  } catch {
    // Gone already: nothing to keep fresh.
  }
}

const LOCK_POLL_MS = 100;
// How long buildNow waits for a build in flight. Short, since pr-poll.ts
// runs it inside the automation's five-minute timeout, and the build in
// flight builds this caller's write anyway (see buildThenRelease).
const BUILD_WAIT_MS = 10_000;

/**
 * Runs `build` at least once, and again each time `snapshot` reads
 * differently from what it was before the previous run: a write that
 * lands while a build is going (the lock is held, so its own event skips
 * scheduling one) is otherwise never built at all, since nothing else
 * schedules a build for it. Stops once a build fails, since retrying an
 * unchanged, already-failing build would not help; stops once two
 * successive snapshots agree, since nothing has changed since that build
 * started. Returns whether the last build succeeded, and the snapshot it
 * built. Exported for testing with fakes instead of a real spawn and file.
 */
export function buildUntilStable(
  build: () => boolean,
  snapshot: () => string | null,
): { ok: boolean; built: string | null } {
  let before = snapshot();
  for (;;) {
    if (!build()) return { ok: false, built: before };
    const after = snapshot();
    if (after === before) return { ok: true, built: after };
    before = after;
  }
}

function readOrMissing(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "(missing)";
  }
}

// A file's size and modification time, or a marker when it is missing.
function stamp(path: string): string {
  const s = statSync(path, { throwIfNoEntry: false });
  return s ? `${s.size}:${s.mtimeMs}` : "(missing)";
}

/**
 * What a build reads, cheaply: the state file's text, plus the size and
 * modification time of config/projects.json and of every file under src/.
 * A tap or a hook changes the first; a pull or a branch switch changes the
 * others, so a source change landing mid-build reads differently here and
 * gets another pass. Stats rather than hashes, since this runs after every
 * build pass. Exported for testing against a temp tree.
 */
export function buildInputs(root: string = ROOT): string {
  const src = join(root, "src");
  let files: string[];
  try {
    files = readdirSync(src, { recursive: true, encoding: "utf8" }).sort();
  } catch {
    files = [];
  }
  const stamps = files.map((f) => `${f} ${stamp(join(src, f))}`);
  const projects = `projects ${stamp(join(root, "config", "projects.json"))}`;
  return [readOrMissing(join(root, "config", "state.json")), projects, ...stamps].join("\n");
}

// Only ever called with BUILD_LOCK held: from buildThenRelease, whose lock
// scheduleBuild, buildNow or lockedBuild took first. Spawns scripts/build.ts
// itself, never `npm run build`, which would wait on this same lock.
// Returns build.ts's exit status, or 1 when it had none (killed on the
// timeout, or never started).
function spawnBuild(stdio: "ignore" | "inherit"): number {
  touchBuildLock();
  const build = spawnSync(process.execPath, ["scripts/build.ts"], {
    cwd: ROOT,
    stdio,
    timeout: BUILD_TIMEOUT_MS,
  });
  return build.status ?? 1;
}

function runBuild(): boolean {
  if (spawnBuild("ignore") === 0) return true;
  console.error("hook-build: build failed");
  return false;
}

/** What the locked build runs against; every field is swappable so a test can use fakes. */
export interface BuildDeps {
  take: () => boolean;
  release: () => void;
  build: () => boolean;
  snapshot: () => string | null;
  pause: (ms: number) => void;
  maxWaitMs: number;
}

const REAL_DEPS: BuildDeps = {
  take: tryTakeBuildLock,
  release: releaseBuildLock,
  build: runBuild,
  snapshot: buildInputs,
  pause: pauseSync,
  maxWaitMs: BUILD_WAIT_MS,
};

/**
 * With the lock held: builds until stable, drops the lock, then looks at
 * the build's inputs once more. A write that found the lock held skipped its
 * own build, trusting this one; if it landed after this build's last look,
 * the lock is retaken and built again, so no write is left unbuilt. When
 * another caller has taken the lock by then, that caller builds it.
 * Returns whether the last build succeeded. Exported for testing.
 */
export function buildThenRelease(d: Pick<BuildDeps, "take" | "release" | "build" | "snapshot">): boolean {
  for (;;) {
    let result: { ok: boolean; built: string | null };
    try {
      result = buildUntilStable(d.build, d.snapshot);
    } finally {
      d.release();
    }
    if (!result.ok) return false;
    if (d.snapshot() === result.built || !d.take()) return true;
  }
}

// The detached side of the coalesce: sleeps so a near-simultaneous write
// lands first, then builds until its inputs stop changing under it,
// dropping the lock once it has.
async function coalesceBuild(): Promise<void> {
  await sleep(COALESCE_MS);
  buildThenRelease(REAL_DEPS);
}

/**
 * Builds now, synchronously, under the same lock scheduleBuild uses:
 * waits a short while for a build in flight rather than racing it, then
 * builds until its inputs stop changing under it and drops the lock.
 * "built" and "failed" say how the build went, so the caller can roll its
 * write back on a failure. "busy" means the lock stayed held: the build
 * holding it builds this write before it lets go (buildThenRelease), so
 * the caller should not roll back.
 */
export function buildNow(deps: Partial<BuildDeps> = {}): "built" | "failed" | "busy" {
  const d: BuildDeps = { ...REAL_DEPS, ...deps };
  if (!waitForLock(d.take, d.maxWaitMs, d.pause, LOCK_POLL_MS)) return "busy";
  return buildThenRelease(d) ? "built" : "failed";
}

/**
 * Spawns the coalescing build detached and unreferenced, so the hook
 * returns at once; skips spawning when one is already in flight. `tag`
 * names the calling hook in any stderr note.
 */
export function scheduleBuild(tag: string): void {
  if (!tryTakeBuildLock()) return;
  const log = logFd();
  try {
    const child = spawn(process.execPath, [import.meta.filename, "--coalesce-build"], {
      cwd: ROOT,
      detached: true,
      stdio: ["ignore", "ignore", log],
    });
    child.on("error", (err) => {
      console.error(`${tag}: build: ${err.message}`);
      releaseBuildLock();
    });
    child.unref();
  } catch (err) {
    console.error(`${tag}: build: ${err instanceof Error ? err.message : String(err)}`);
    releaseBuildLock();
  } finally {
    if (log !== "ignore") closeSync(log);
  }
}

/** What `npm run build` runs against: the build returns build.ts's exit status. */
export interface LockedBuildDeps extends Omit<BuildDeps, "build"> {
  build: () => number;
}

// One poll past the stale threshold: a lock that is still held by then is
// a live build's (a holder touches it before every pass), and one left by
// a crashed build has gone stale and been retaken on the way.
const LOCKED_WAIT_MS = BUILD_LOCK_STALE_MS + LOCK_POLL_MS;

const LOCKED_DEPS: LockedBuildDeps = {
  ...REAL_DEPS,
  build: () => spawnBuild("inherit"),
  maxWaitMs: LOCKED_WAIT_MS,
};

/**
 * `npm run build`: waits for the build lock however long a live build
 * could hold it, then builds with build.ts's output shown, until the
 * inputs stop changing, and drops the lock. Returns build.ts's exit status
 * from the last pass, so a failure still fails a git hook or the check, or
 * 1 when the lock never came free.
 */
export function lockedBuild(deps: Partial<LockedBuildDeps> = {}): number {
  const d: LockedBuildDeps = { ...LOCKED_DEPS, ...deps };
  if (!waitForLock(d.take, d.maxWaitMs, d.pause, LOCK_POLL_MS)) {
    console.error("build: the build lock (config/hook-build.lock) stayed held; try again");
    return 1;
  }
  let status = 0;
  buildThenRelease({
    ...d,
    build: () => {
      status = d.build();
      return status === 0;
    },
  });
  return status;
}

if (import.meta.main && process.argv[2] === "--coalesce-build") await coalesceBuild();
if (import.meta.main && process.argv[2] === "--locked") process.exitCode = lockedBuild();
