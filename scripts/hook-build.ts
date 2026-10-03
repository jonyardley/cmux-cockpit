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
// Every redraw of a sidebar rebuilds its whole view tree in cmux, and cmux
// aborted twice on 2026-09-30 when SwiftUI's view graph ran out of room
// after bursts of redraws a few seconds apart. So a build from a hook or a
// poll first waits out a gap since a bundle was last rewritten (settleGap),
// coalescing every write in that time into one redraw. How long depends on
// who asked (Pace): a busy agent's chatter ("Your move" lines, background
// shells, subagent runs) waits SLOW_GAP_MS, since cmux's own live data
// already shows that an agent is working; a PR, a "needs you" reason or
// any other hook waits REDRAW_GAP_MS; a tap is Jon waiting on screen and
// waits TAP_GAP_MS. A faster write raises a flag that cuts a slower wait
// already under way, and `npm run build` raises the tap's flag when it
// finds a build waiting, and never waits out the gap itself.
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
import { unreadableCopyOf } from "./state-url.ts";

const ROOT = join(import.meta.dirname, "..");
const BUILD_LOCK = join(ROOT, "config", "hook-build.lock");
// Raised by a tap so a build waiting out the redraw gap goes at once.
const URGENT_FLAG = join(ROOT, "config", "build-urgent");
// Raised by a write at the usual pace, so a build waiting out the slow gap
// for an agent's chatter waits no longer than REDRAW_GAP_MS.
const SOON_FLAG = join(ROOT, "config", "build-soon");
const BUNDLES = ["agents", "cockpit"].map((name) => join(ROOT, "sidebars", `${name}.js`));
// Exported so a test can check the stale threshold sits comfortably above
// this delay plus the timeout, without duplicating the figures.
export const COALESCE_MS = 300;
export const BUILD_TIMEOUT_MS = 60_000;
// Comfortably above the coalesce delay plus how long one build pass may
// run: the redraw gap it may wait out, then the build's timeout (see
// REDRAW_GAP_MS). A holder touches the lock before every pass, so a
// build that is genuinely still going, however many passes it takes for
// writes that landed mid-build, is never mistaken for a crashed one's and
// retaken out from under it.
export const BUILD_LOCK_STALE_MS = 2 * BUILD_TIMEOUT_MS;
// The least time between two redraws from hooks and polls. With the build's
// timeout it stays under the stale threshold, so a holder waiting it out is
// never taken for a crashed one.
export const REDRAW_GAP_MS = 20_000;
// The least time between two redraws when only an agent's chatter is
// waiting: a "Your move" line, a background shell or a subagent run. These
// change every few seconds while agents are busy and drove most of the
// redraws (57 to 113 an hour on 2026-10-02). Under the stale threshold on
// its own, and the holder touches the lock through the wait as well.
export const SLOW_GAP_MS = 90_000;
// The least time between redraws once a tap cuts the wait short, so quick
// taps in a row still do not redraw back to back.
export const TAP_GAP_MS = 1_000;
const GAP_STEP_MS = 250;

/** How soon a write needs to show: "tap" is Jon waiting on screen, "soon" a
 * PR, a "needs you" reason or the like, "slow" an agent's chatter. */
export type Pace = "tap" | "soon" | "slow";

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
// How long buildNow waits for a build in flight: longer than a holder can
// spend waiting out the redraw gap, so the poll gets its own build result
// and can roll back on a failure, yet well inside the automation's
// five-minute timeout. The build in flight builds this caller's write
// anyway if the wait runs out (see buildThenRelease).
const BUILD_WAIT_MS = REDRAW_GAP_MS + 10_000;

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
  snapshot: () => string,
  settle: () => void = () => {},
): { ok: boolean; built: string } {
  for (;;) {
    settle();
    const before = snapshot();
    if (!build()) return { ok: false, built: before };
    if (snapshot() === before) return { ok: true, built: before };
  }
}

/**
 * How long is left of the redraw gap at `now`, given the last redraw's
 * time. Never more than the gap, so a bundle stamped in the future (the
 * clock stepped back) cannot hold a build, and the lock, indefinitely.
 */
export const gapLeft = (now: number, lastRedraw: number, gap: number = REDRAW_GAP_MS): number =>
  Math.min(gap, Math.max(0, lastRedraw + gap - now));

/** What settleGap reads and waits with; swappable so a test can use fakes. */
export interface GapDeps {
  now: () => number;
  lastRedraw: () => number;
  urgent: () => boolean;
  soon: () => boolean;
  pause: (ms: number) => void;
}

/**
 * Waits out what is left of the redraw gap, in short steps so a flag
 * raised mid-wait cuts it: the slow gap by default, REDRAW_GAP_MS once a
 * write at the usual pace raises the soon flag, TAP_GAP_MS once a tap
 * raises the urgent one. A flag only ever shortens the wait. Returns at
 * once when the gap has passed. Exported for testing.
 */
export function settleGap(d: GapDeps): void {
  let gap = SLOW_GAP_MS;
  for (;;) {
    if (d.urgent()) gap = TAP_GAP_MS;
    else if (d.soon()) gap = Math.min(gap, REDRAW_GAP_MS);
    const left = gapLeft(d.now(), d.lastRedraw(), gap);
    if (left <= 0) return;
    d.pause(Math.min(left, GAP_STEP_MS));
  }
}

// When a bundle was last rewritten, which is when cmux last redrew: an
// unchanged bundle is never written (write-if-changed.ts). 0 with none.
function lastRedraw(): number {
  return Math.max(0, ...BUNDLES.map((f) => statSync(f, { throwIfNoEntry: false })?.mtimeMs ?? 0));
}

// Takes down a flag, saying whether it was up.
function takeFlag(flag: string): boolean {
  try {
    rmSync(flag);
    return true;
  } catch {
    return false;
  }
}

// No flag raised: the write waits out the slower gap instead.
function raiseFlag(flag: string): void {
  try {
    closeSync(openSync(flag, "a"));
  } catch {
    // Nothing to do: see above.
  }
}

const takeUrgent = (): boolean => takeFlag(URGENT_FLAG);
const takeSoon = (): boolean => takeFlag(SOON_FLAG);
const raiseUrgent = (): void => raiseFlag(URGENT_FLAG);
const raiseSoon = (): void => raiseFlag(SOON_FLAG);

// Takes down both flags: whatever raised them, this build covers it.
const takeFlags = (): void => {
  takeUrgent();
  takeSoon();
};

// The lock is touched before the wait, through it and before the build, so
// the wait never counts towards its age.
const throttle = (): void => {
  touchBuildLock();
  settleGap({
    now: Date.now,
    lastRedraw,
    urgent: takeUrgent,
    soon: takeSoon,
    pause: (ms) => {
      pauseSync(ms);
      touchBuildLock();
    },
  });
};

// The one marker for a file that is not there, so its absence still reads
// the same each time and its arrival reads differently.
const MISSING = "(missing)";

function readOrMissing(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return MISSING;
  }
}

// A file's size and modification time, or MISSING.
function stamp(path: string): string {
  const s = statSync(path, { throwIfNoEntry: false });
  return s ? `${s.size}:${s.mtimeMs}` : MISSING;
}

// The .ts files under `dir` (every depth when `deep`), relative and sorted.
// Only .ts, so an editor's swap file, an atomic save's temp file or a
// .DS_Store never reads as a change and costs a build pass.
function tsFiles(dir: string, deep: boolean): string[] {
  try {
    return readdirSync(dir, { recursive: deep, encoding: "utf8" })
      .filter((f) => f.endsWith(".ts"))
      .sort();
  } catch {
    return [];
  }
}

/**
 * What a build reads, cheaply: the state file's text, plus the size and
 * modification time of everything else build.ts reads: the project table
 * and its committed fallback, the state file's unreadable copy, every .ts
 * file under src/ and the scripts (build.ts and the modules it imports) in
 * scripts/. A tap or a hook changes the first; a pull or a branch switch
 * changes the others, so a source change landing mid-build reads
 * differently here and gets another pass. Stats rather than hashes, since
 * this runs after every build pass. Exported for testing against a temp
 * tree.
 */
export function buildInputs(root: string = ROOT): string {
  const state = join(root, "config", "state.json");
  const files = [
    join(root, "config", "projects.json"),
    join(root, "config", "projects.example.json"),
    unreadableCopyOf(state),
    ...tsFiles(join(root, "src"), true).map((f) => join(root, "src", f)),
    ...tsFiles(join(root, "scripts"), false).map((f) => join(root, "scripts", f)),
  ];
  return [readOrMissing(state), ...files.map((f) => `${f} ${stamp(f)}`)].join("\n");
}

// Only ever called with BUILD_LOCK held: from buildThenRelease, whose lock
// scheduleBuild, buildNow or lockedBuild took first. Spawns scripts/build.ts
// itself, never `npm run build`, which would wait on this same lock.
// Returns build.ts's exit status, or 1 when it had none, saying why: killed
// on the timeout or by a signal, or never started.
function spawnBuild(stdio: "ignore" | "inherit"): number {
  touchBuildLock();
  const build = spawnSync(process.execPath, ["scripts/build.ts"], {
    cwd: ROOT,
    stdio,
    timeout: BUILD_TIMEOUT_MS,
  });
  if (build.status !== null) return build.status;
  if (build.error) console.error(`build: could not run scripts/build.ts: ${build.error.message}`);
  else
    console.error(
      `build: scripts/build.ts stopped by ${build.signal ?? "a signal"} (the timeout is ${BUILD_TIMEOUT_MS / 1000}s)`,
    );
  return 1;
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
  snapshot: () => string;
  /** Runs before each build pass: the redraw gap for hooks and polls. */
  settle: () => void;
  pause: (ms: number) => void;
  maxWaitMs: number;
  /** Tells a build waiting out a slower gap to go sooner. */
  hurry: () => void;
}

const REAL_DEPS: BuildDeps = {
  take: tryTakeBuildLock,
  release: releaseBuildLock,
  build: runBuild,
  snapshot: buildInputs,
  settle: throttle,
  pause: pauseSync,
  maxWaitMs: BUILD_WAIT_MS,
  hurry: raiseSoon,
};

/**
 * With the lock held: builds until stable, drops the lock, then looks at
 * the build's inputs once more. A write that found the lock held skipped its
 * own build, trusting this one; if it landed after this build's last look,
 * the lock is retaken and built again, so no write is left unbuilt. When
 * another caller has taken the lock by then, that caller builds it.
 * Returns whether the last build succeeded. Exported for testing.
 */
export function buildThenRelease(
  d: Pick<BuildDeps, "take" | "release" | "build" | "snapshot"> & Partial<Pick<BuildDeps, "settle">>,
): boolean {
  for (;;) {
    let result: { ok: boolean; built: string };
    try {
      result = buildUntilStable(d.build, d.snapshot, d.settle);
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
 * Builds now, synchronously, under the same lock scheduleBuild uses, at
 * the usual pace: raises the soon flag so its own wait, or one already
 * under way for an agent's chatter, is REDRAW_GAP_MS at most. It
 * waits a short while for a build in flight rather than racing it, then
 * builds until its inputs stop changing under it and drops the lock.
 * "built" and "failed" say how the build went, so the caller can roll its
 * write back on a failure. "busy" means the lock stayed held: the build
 * holding it builds this write before it lets go (buildThenRelease), so
 * the caller should not roll back.
 */
export function buildNow(deps: Partial<BuildDeps> = {}): "built" | "failed" | "busy" {
  const d: BuildDeps = { ...REAL_DEPS, ...deps };
  d.hurry();
  if (!waitForLock(d.take, d.maxWaitMs, d.pause, LOCK_POLL_MS)) return "busy";
  return buildThenRelease(d) ? "built" : "failed";
}

/**
 * Spawns the coalescing build detached and unreferenced, so the hook
 * returns at once; skips spawning when one is already in flight. `tag`
 * names the calling hook in any stderr note. `pace` sets how long the
 * build waits since the last redraw (see Pace), and a faster pace cuts the
 * wait of a build already waiting.
 */
export function scheduleBuild(tag: string, pace: Pace = "soon"): void {
  if (pace === "tap") raiseUrgent();
  if (pace === "soon") raiseSoon();
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
      takeFlags();
      releaseBuildLock();
    });
    child.unref();
  } catch (err) {
    console.error(`${tag}: build: ${err instanceof Error ? err.message : String(err)}`);
    takeFlags();
    releaseBuildLock();
  } finally {
    if (log !== "ignore") closeSync(log);
  }
}

/** What `npm run build` runs against: the build returns build.ts's exit
 * status, and `hurry` tells a build waiting out a gap to go now. */
export interface LockedBuildDeps extends Omit<BuildDeps, "build"> {
  build: () => number;
}

// One poll past the stale threshold: a lock that is still held by then is
// a live build's (a holder touches it before every pass), and one left by
// a crashed build has gone stale and been retaken on the way.
const LOCKED_WAIT_MS = BUILD_LOCK_STALE_MS + LOCK_POLL_MS;

// Once `npm run build` holds the lock, a Ctrl-C or a kill must not end it
// before buildThenRelease's `finally` drops the lock: a lock left behind
// looks live for two minutes, and every tap in that time skips its build,
// trusting a holder that is gone. With a listener, node no longer dies on
// the signal mid-build: a Ctrl-C also stops the build child (same process
// group), so that pass fails, the lock is dropped and the run exits 1; a
// signal to this process alone lets the pass finish first. The listener
// exits with the usual status if the event loop gets to it, which a run
// this short usually does not. Only once the lock is taken, since the wait
// for it is a synchronous pause no listener could interrupt, and dying
// there leaves nothing held. A SIGKILL still leaves the lock, to go stale
// as before.
function exitOnSignalOnceHeld(): void {
  for (const [signal, code] of [
    ["SIGINT", 130],
    ["SIGTERM", 143],
    ["SIGHUP", 129],
  ] as const) {
    process.once(signal, () => process.exit(code));
  }
}

function takeForLockedBuild(): boolean {
  if (!tryTakeBuildLock()) return false;
  exitOnSignalOnceHeld();
  return true;
}

const LOCKED_DEPS: LockedBuildDeps = {
  ...REAL_DEPS,
  take: takeForLockedBuild,
  build: () => spawnBuild("inherit"),
  // A deliberate build (a git hook, the close-out, the check) goes at once,
  // and takes down both flags, since it builds whatever raised them.
  settle: takeFlags,
  hurry: raiseUrgent,
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
  let said = false;
  // Says once why it is waiting, so a git hook's `npm run --silent build`
  // held up by a build in flight never reads as a hang.
  const take = (): boolean => {
    if (d.take()) return true;
    if (!said) {
      console.error("build: waiting for the build in flight (config/hook-build.lock)");
      d.hurry();
    }
    said = true;
    return false;
  };
  if (!waitForLock(take, d.maxWaitMs, d.pause, LOCK_POLL_MS)) {
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
