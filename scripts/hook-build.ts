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

import { spawn, spawnSync } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { LOG_PATH } from "./state-log.ts";

const ROOT = join(import.meta.dirname, "..");
const STATE_PATH = join(ROOT, "config", "state.json");
const BUILD_LOCK = join(ROOT, "config", "hook-build.lock");
// Exported so a test can check the stale threshold sits comfortably above
// this delay plus the timeout, without duplicating the figures.
export const COALESCE_MS = 300;
export const BUILD_TIMEOUT_MS = 60_000;
// Comfortably above the coalesce delay plus how long a build may run (2x
// the timeout), so a build that is genuinely still going, including a
// second pass buildUntilStable takes for a write that landed mid-build, is
// never mistaken for a crashed one's and retaken out from under it.
export const BUILD_LOCK_STALE_MS = 2 * BUILD_TIMEOUT_MS;

function logFd(): number | "ignore" {
  try {
    return openSync(LOG_PATH, "a");
  } catch {
    return "ignore";
  }
}

// Exclusive lockfile, the same shape as pr-poll.ts's and state-url.ts's: a
// stale one (older than a build could plausibly take) is a crashed build's.
function tryTakeBuildLock(): boolean {
  mkdirSync(join(ROOT, "config"), { recursive: true });
  try {
    closeSync(openSync(BUILD_LOCK, "wx"));
    return true;
  } catch {
    const age = Date.now() - (statSync(BUILD_LOCK, { throwIfNoEntry: false })?.mtimeMs ?? Date.now());
    if (age <= BUILD_LOCK_STALE_MS) return false;
    try {
      rmSync(BUILD_LOCK, { force: true });
      closeSync(openSync(BUILD_LOCK, "wx"));
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * Runs `build` at least once, and again each time `snapshot` reads
 * differently from what it was before the previous run: a write that
 * lands while a build is going (the lock is held, so its own event skips
 * scheduling one) is otherwise never built at all, since nothing else
 * schedules a build for it. Stops once a build fails, since retrying an
 * unchanged, already-failing build would not help; stops once two
 * successive snapshots agree, since nothing has changed since that build
 * started. Exported for testing with fakes instead of a real spawn and file.
 */
export function buildUntilStable(build: () => boolean, snapshot: () => string | null): void {
  let before = snapshot();
  for (;;) {
    if (!build()) return;
    const after = snapshot();
    if (after === before) return;
    before = after;
  }
}

function stateSnapshot(): string | null {
  try {
    return readFileSync(STATE_PATH, "utf8");
  } catch {
    return null;
  }
}

function runBuild(): boolean {
  const build = spawnSync(process.execPath, ["scripts/build.ts"], {
    cwd: ROOT,
    stdio: "ignore",
    timeout: BUILD_TIMEOUT_MS,
  });
  if (build.status === 0) return true;
  console.error("hook-build: build failed");
  return false;
}

// The detached side of the coalesce: sleeps so a near-simultaneous write
// lands first, then builds until the state file stops changing under it,
// then drops the lock so the next visible change can schedule its own
// build.
async function coalesceBuild(): Promise<void> {
  await sleep(COALESCE_MS);
  buildUntilStable(runBuild, stateSnapshot);
  rmSync(BUILD_LOCK, { force: true });
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
      rmSync(BUILD_LOCK, { force: true });
    });
    child.unref();
  } catch (err) {
    console.error(`${tag}: build: ${err instanceof Error ? err.message : String(err)}`);
    rmSync(BUILD_LOCK, { force: true });
  } finally {
    if (log !== "ignore") closeSync(log);
  }
}

if (import.meta.main && process.argv[2] === "--coalesce-build") await coalesceBuild();
