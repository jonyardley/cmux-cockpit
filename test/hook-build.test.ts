// The build lock every state write's rebuild goes through
// (scripts/hook-build.ts, on scripts/lockfile.ts): waiting for it, retaking
// a crashed build's, and buildNow, the synchronous locked build pr-poll.ts
// uses. The lock tests
// use a temp file and the build ones fakes, so nothing here spawns a build.

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { BUILD_LOCK_STALE_MS, buildNow, buildThenRelease } from "../scripts/hook-build.ts";
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
        snapshot: () => snapshots[Math.min(i++, snapshots.length - 1)] ?? null,
        pause: () => events.push("pause"),
        maxWaitMs: 500,
      },
    };
  }

  it("waits for a build in flight, builds once, then drops the lock", () => {
    let tries = 0;
    const { events, deps } = fakes({ take: () => ++tries > 2 });
    assert.equal(buildNow(deps), "built");
    assert.deepEqual(events, ["busy", "pause", "busy", "pause", "take", "build", "release"]);
  });

  it("builds again when a write lands while it builds", () => {
    const { events, deps } = fakes({ snapshots: ["v0", "v1", "v1"] });
    assert.equal(buildNow(deps), "built");
    assert.deepEqual(events, ["take", "build", "build", "release"]);
  });

  it("reports a failed build, still dropping the lock", () => {
    const { events, deps } = fakes({ build: () => false });
    assert.equal(buildNow(deps), "failed");
    assert.deepEqual(events, ["take", "build", "release"]);
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
