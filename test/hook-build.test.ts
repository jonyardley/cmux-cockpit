// The build lock every rebuild goes through (scripts/hook-build.ts, on
// scripts/lockfile.ts): waiting for it, retaking a crashed build's, buildNow,
// the synchronous locked build pr-poll.ts uses, lockedBuild, what
// `npm run build` runs, and buildInputs, the snapshot that says whether
// anything changed mid-build. The lock tests and buildInputs use temp
// files and the build ones fakes, so nothing here spawns a build.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import {
  BUILD_LOCK_STALE_MS,
  BUILD_TIMEOUT_MS,
  buildInputs,
  buildNow,
  buildThenRelease,
  gapLeft,
  lockedBuild,
  REDRAW_GAP_MS,
  settleGap,
} from "../scripts/hook-build.ts";
import { tryTakeLock, waitForLock } from "../scripts/lockfile.ts";

describe("tryTakeLock", () => {
  const dir = mkdtempSync(join(tmpdir(), "hook-build-"));
  after(() => rmSync(dir, { recursive: true, force: true }));

  it("takes a free lock, then refuses while it is held", () => {
    const lock = join(dir, "free.lock");
    assert.equal(tryTakeLock(lock, BUILD_LOCK_STALE_MS), true);
    assert.equal(existsSync(lock), true);
    assert.equal(tryTakeLock(lock, BUILD_LOCK_STALE_MS), false);
  });

  it("retakes a lock older than the stale threshold, as a crashed build's", () => {
    const lock = join(dir, "stale.lock");
    writeFileSync(lock, "");
    const old = (Date.now() - BUILD_LOCK_STALE_MS - 1000) / 1000;
    utimesSync(lock, old, old);
    assert.equal(tryTakeLock(lock, BUILD_LOCK_STALE_MS), true);
    // Retaken, so it is fresh again and the next caller waits.
    assert.equal(tryTakeLock(lock, BUILD_LOCK_STALE_MS), false);
  });

  it("leaves a lock younger than the threshold alone", () => {
    const lock = join(dir, "young.lock");
    writeFileSync(lock, "");
    assert.equal(tryTakeLock(lock, 60_000), false);
    assert.equal(existsSync(lock), true);
  });
});

describe("waitForLock", () => {
  it("takes the lock once the holder lets go, pausing between tries", () => {
    let tries = 0;
    const pauses: number[] = [];
    const took = waitForLock(
      () => ++tries === 3,
      1000,
      (ms: number) => pauses.push(ms),
      100,
    );
    assert.equal(took, true);
    assert.deepEqual(pauses, [100, 100]);
  });

  it("gives up once the wait is spent", () => {
    let tries = 0;
    const took = waitForLock(
      () => {
        tries++;
        return false;
      },
      300,
      () => {},
      100,
    );
    assert.equal(took, false);
    // At 0, 100, 200 and 300ms waited.
    assert.equal(tries, 4);
  });

  it("still tries once with no wait at all", () => {
    assert.equal(
      waitForLock(
        () => true,
        0,
        () => assert.fail("no pause needed"),
        100,
      ),
      true,
    );
  });
});

describe("buildNow", () => {
  // A lock held by the fakes, and a record of what ran in what order.
  function fakes(overrides: { take?: () => boolean; build?: () => boolean; snapshots?: string[] } = {}) {
    const events: string[] = [];
    const snapshots = overrides.snapshots ?? ["v0", "v0"];
    let i = 0;
    return {
      events,
      deps: {
        take: () => {
          const took = overrides.take ? overrides.take() : true;
          events.push(took ? "take" : "busy");
          return took;
        },
        release: () => events.push("release"),
        build: () => {
          events.push("build");
          return overrides.build ? overrides.build() : true;
        },
        snapshot: () => snapshots[Math.min(i++, snapshots.length - 1)] ?? "v0",
        settle: () => events.push("settle"),
        pause: () => events.push("pause"),
        maxWaitMs: 500,
      },
    };
  }

  it("waits for a build in flight, builds once, then drops the lock", () => {
    let tries = 0;
    const { events, deps } = fakes({ take: () => ++tries > 2 });
    assert.equal(buildNow(deps), "built");
    assert.deepEqual(events, ["busy", "pause", "busy", "pause", "take", "settle", "build", "release"]);
  });

  it("builds again when a write lands while it builds", () => {
    const { events, deps } = fakes({ snapshots: ["v0", "v1", "v1"] });
    assert.equal(buildNow(deps), "built");
    assert.deepEqual(events, ["take", "settle", "build", "settle", "build", "release"]);
  });

  it("reports a failed build, still dropping the lock", () => {
    const { events, deps } = fakes({ build: () => false });
    assert.equal(buildNow(deps), "failed");
    assert.deepEqual(events, ["take", "settle", "build", "release"]);
  });

  it("drops the lock even when the build throws", () => {
    const { events, deps } = fakes({
      build: () => {
        throw new Error("boom");
      },
    });
    assert.throws(() => buildNow(deps), /boom/);
    assert.equal(events.at(-1), "release");
  });

  it("reports busy, building and releasing nothing, when the lock stays held", () => {
    const { events, deps } = fakes({ take: () => false });
    assert.equal(buildNow({ ...deps, maxWaitMs: 200 }), "busy");
    assert.equal(events.includes("build"), false);
    assert.equal(events.includes("release"), false);
  });
});

describe("buildThenRelease", () => {
  it("builds again after dropping the lock when a write landed after its last look", () => {
    // v0 built and stable (v0, v0); then, just as the lock drops, a write
    // that found it held lands (v1): retaken and built, then stable.
    const snapshots = ["v0", "v0", "v1", "v1", "v1", "v1"];
    let i = 0;
    const events: string[] = [];
    const ok = buildThenRelease({
      take: () => {
        events.push("take");
        return true;
      },
      release: () => events.push("release"),
      build: () => {
        events.push("build");
        return true;
      },
      snapshot: () => snapshots[i++] ?? "v1",
    });
    assert.equal(ok, true);
    assert.deepEqual(events, ["build", "release", "take", "build", "release"]);
  });

  it("leaves the late write to whoever took the lock first", () => {
    const snapshots = ["v0", "v0", "v1"];
    let i = 0;
    const events: string[] = [];
    buildThenRelease({
      take: () => {
        events.push("busy");
        return false;
      },
      release: () => events.push("release"),
      build: () => {
        events.push("build");
        return true;
      },
      snapshot: () => snapshots[i++] ?? "v1",
    });
    assert.deepEqual(events, ["build", "release", "busy"]);
  });
});

// A temp checkout with the files a build reads, for buildInputs.
function tempTree(): string {
  const root = mkdtempSync(join(tmpdir(), "hook-build-inputs-"));
  mkdirSync(join(root, "src", "shared"), { recursive: true });
  mkdirSync(join(root, "config"));
  mkdirSync(join(root, "scripts"));
  writeFileSync(join(root, "scripts", "build.ts"), "// build\n");
  writeFileSync(join(root, "src", "shared", "a.ts"), "export const a = 1;\n");
  writeFileSync(join(root, "config", "state.json"), "{}");
  return root;
}

describe("buildInputs", () => {
  const roots: string[] = [];
  after(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  });
  const tree = (): string => {
    const root = tempTree();
    roots.push(root);
    return root;
  };

  it("reads the same while nothing changes", () => {
    const root = tree();
    assert.equal(buildInputs(root), buildInputs(root));
  });

  it("changes with the state file", () => {
    const root = tree();
    const before = buildInputs(root);
    writeFileSync(join(root, "config", "state.json"), '{"dismissed":{}}');
    assert.notEqual(buildInputs(root), before);
  });

  it("changes when a source file changes, is added or goes", () => {
    const root = tree();
    const first = buildInputs(root);
    writeFileSync(join(root, "src", "shared", "a.ts"), "export const a = 22;\n");
    const edited = buildInputs(root);
    assert.notEqual(edited, first);
    writeFileSync(join(root, "src", "shared", "b.ts"), "export const b = 2;\n");
    const added = buildInputs(root);
    assert.notEqual(added, edited);
    rmSync(join(root, "src", "shared", "b.ts"));
    assert.notEqual(buildInputs(root), added);
  });

  it("changes when the project table appears", () => {
    const root = tree();
    const before = buildInputs(root);
    writeFileSync(join(root, "config", "projects.json"), "[]");
    assert.notEqual(buildInputs(root), before);
  });

  it("changes with the build script and the committed fallback table", () => {
    const root = tree();
    const before = buildInputs(root);
    writeFileSync(join(root, "scripts", "build.ts"), "// changed\n");
    const script = buildInputs(root);
    assert.notEqual(script, before);
    writeFileSync(join(root, "config", "projects.example.json"), "[]");
    assert.notEqual(buildInputs(root), script);
  });

  it("changes when the state file's unreadable copy appears", () => {
    const root = tree();
    const before = buildInputs(root);
    writeFileSync(join(root, "config", "state.json.unreadable.bak"), "{");
    assert.notEqual(buildInputs(root), before);
  });

  it("ignores files that are not TypeScript, such as an editor's swap file", () => {
    const root = tree();
    const before = buildInputs(root);
    writeFileSync(join(root, "src", "shared", ".a.ts.swp"), "x");
    writeFileSync(join(root, "src", ".DS_Store"), "x");
    assert.equal(buildInputs(root), before);
  });

  it("still reads, the same each time, with no src or state at all", () => {
    const root = mkdtempSync(join(tmpdir(), "hook-build-empty-"));
    roots.push(root);
    assert.equal(buildInputs(root), buildInputs(root));
  });
});

describe("lockedBuild", () => {
  const dirs: string[] = [];
  after(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });

  // Fakes like buildNow's, but the build returns an exit status.
  function fakes(overrides: { take?: () => boolean; build?: () => number; snapshot?: () => string } = {}) {
    const events: string[] = [];
    return {
      events,
      deps: {
        take: () => {
          const took = overrides.take ? overrides.take() : true;
          events.push(took ? "take" : "busy");
          return took;
        },
        release: () => events.push("release"),
        build: () => {
          events.push("build");
          return overrides.build ? overrides.build() : 0;
        },
        snapshot: overrides.snapshot ?? (() => "v0"),
        pause: () => events.push("pause"),
        maxWaitMs: 500,
      },
    };
  }

  it("waits on a held lock, then builds once and drops it", () => {
    let tries = 0;
    const { events, deps } = fakes({ take: () => ++tries > 2 });
    assert.equal(lockedBuild(deps), 0);
    assert.deepEqual(events, ["busy", "pause", "busy", "pause", "take", "build", "release"]);
  });

  it("waits as long as a live build could hold the lock by default", () => {
    // A lock that never frees: count the pauses the default wait allows,
    // without any real sleeping.
    let paused = 0;
    const status = lockedBuild({
      take: () => false,
      pause: (ms: number) => {
        paused += ms;
      },
    });
    assert.equal(status, 1);
    assert.ok(paused >= BUILD_LOCK_STALE_MS, `waited ${paused}ms`);
  });

  it("retakes a crashed build's stale lock and builds", () => {
    const dir = mkdtempSync(join(tmpdir(), "hook-build-locked-"));
    dirs.push(dir);
    const lock = join(dir, "hook-build.lock");
    writeFileSync(lock, "");
    const old = (Date.now() - BUILD_LOCK_STALE_MS - 1000) / 1000;
    utimesSync(lock, old, old);
    const { events, deps } = fakes({ take: () => tryTakeLock(lock, BUILD_LOCK_STALE_MS) });
    assert.equal(lockedBuild({ ...deps, release: () => rmSync(lock, { force: true }) }), 0);
    assert.deepEqual(events, ["take", "build"]);
    assert.equal(existsSync(lock), false);
  });

  it("builds again when a source change lands mid-build", () => {
    const root = tempTree();
    dirs.push(root);
    let builds = 0;
    const { events, deps } = fakes({
      snapshot: () => buildInputs(root),
      build: () => {
        // A pull landing during the first pass only.
        if (++builds === 1) writeFileSync(join(root, "src", "shared", "a.ts"), "export const a = 333;\n");
        return 0;
      },
    });
    assert.equal(lockedBuild(deps), 0);
    assert.deepEqual(events, ["take", "build", "build", "release"]);
  });

  it("passes a failed build's exit status through, still dropping the lock", () => {
    const { events, deps } = fakes({ build: () => 2 });
    assert.equal(lockedBuild(deps), 2);
    assert.deepEqual(events, ["take", "build", "release"]);
  });

  it("reports the last pass's status when a rebuild fails", () => {
    let pass = 0;
    const snapshots = ["v0", "v1"];
    const { deps } = fakes({
      build: () => (++pass === 1 ? 0 : 1),
      snapshot: () => snapshots[Math.min(pass, 1)] ?? "v1",
    });
    assert.equal(lockedBuild(deps), 1);
    assert.equal(pass, 2);
  });

  it("fails without building when the lock stays held", () => {
    const { events, deps } = fakes({ take: () => false });
    assert.equal(lockedBuild({ ...deps, maxWaitMs: 200 }), 1);
    assert.equal(events.includes("build"), false);
    assert.equal(events.includes("release"), false);
  });
});

describe("the redraw gap", () => {
  it("is what is left of the gap since the last redraw, never below nothing", () => {
    assert.equal(gapLeft(1_000, 0, 20_000), 19_000);
    assert.equal(gapLeft(5_000, 0, 20_000), 15_000);
    assert.equal(gapLeft(50_000, 0, 20_000), 0);
  });

  it("with the build's timeout, stays under the lock's stale threshold", () => {
    assert.ok(REDRAW_GAP_MS + BUILD_TIMEOUT_MS < BUILD_LOCK_STALE_MS);
  });

  // A clock that moves only when the fake pause says so.
  function clock(start: number) {
    let t = start;
    const pauses: number[] = [];
    return {
      pauses,
      now: () => t,
      pause: (ms: number) => {
        pauses.push(ms);
        t += ms;
      },
    };
  }

  it("waits out the rest of the gap in short steps", () => {
    const c = clock(REDRAW_GAP_MS - 600);
    settleGap({ now: c.now, lastRedraw: () => 0, urgent: () => false, pause: c.pause });
    assert.deepEqual(c.pauses, [250, 250, 100]);
  });

  it("does not wait once the gap has passed", () => {
    const c = clock(REDRAW_GAP_MS + 1);
    settleGap({ now: c.now, lastRedraw: () => 0, urgent: () => false, pause: c.pause });
    assert.deepEqual(c.pauses, []);
  });

  it("stops waiting as soon as a tap raises the urgent flag", () => {
    const c = clock(0);
    settleGap({ now: c.now, lastRedraw: () => 0, urgent: () => c.pauses.length === 2, pause: c.pause });
    assert.deepEqual(c.pauses, [250, 250]);
  });

  it("settles before every build pass, so writes in the wait join that pass", () => {
    const events: string[] = [];
    const snapshots = ["v0", "v1", "v1", "v1"];
    let i = 0;
    buildThenRelease({
      take: () => true,
      release: () => events.push("release"),
      build: () => events.push("build") > 0,
      snapshot: () => snapshots[Math.min(i++, snapshots.length - 1)] ?? "v1",
      settle: () => events.push("settle"),
    });
    assert.deepEqual(events, ["settle", "build", "settle", "build", "release"]);
  });
});
