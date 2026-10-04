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
  COALESCE_MS,
  changedKeys,
  flagFor,
  gapLeft,
  LATER_MS,
  lateBuildArranged,
  lockedBuild,
  PACE_GAP,
  REDRAW_GAP_MS,
  recordTag,
  SLOW_GAP_MS,
  settleGap,
  TAP_GAP_MS,
  takeTags,
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
    const notes: string[] = [];
    const snapshots = overrides.snapshots ?? ["v0", "v0"];
    let i = 0;
    return {
      events,
      notes,
      deps: {
        note: (tag: string) => notes.push(tag),
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
        hurry: () => events.push("hurry"),
      },
    };
  }

  it("waits for a build in flight, builds once, then drops the lock", () => {
    let tries = 0;
    const { events, deps } = fakes({ take: () => ++tries > 2 });
    assert.equal(buildNow("pr-poll", deps), "built");
    // Hurries first, so a build already waiting for an agent's chatter
    // goes within the usual gap and this wait does not run out.
    assert.deepEqual(events, ["hurry", "busy", "pause", "busy", "pause", "take", "settle", "build", "release"]);
  });

  it("builds again when a write lands while it builds", () => {
    const { events, deps } = fakes({ snapshots: ["v0", "v1", "v1"] });
    assert.equal(buildNow("pr-poll", deps), "built");
    assert.deepEqual(events, ["hurry", "take", "settle", "build", "settle", "build", "release"]);
  });

  it("reports a failed build, still dropping the lock", () => {
    const { events, deps } = fakes({ build: () => false });
    assert.equal(buildNow("pr-poll", deps), "failed");
    assert.deepEqual(events, ["hurry", "take", "settle", "build", "release"]);
  });

  it("drops the lock even when the build throws", () => {
    const { events, deps } = fakes({
      build: () => {
        throw new Error("boom");
      },
    });
    assert.throws(() => buildNow("pr-poll", deps), /boom/);
    assert.equal(events.at(-1), "release");
  });

  it("records its tag for the build's log line, even when the lock stays held", () => {
    const built = fakes();
    buildNow("pr-poll", built.deps);
    assert.deepEqual(built.notes, ["pr-poll"]);
    const busy = fakes({ take: () => false });
    buildNow("pr-poll", { ...busy.deps, maxWaitMs: 200 });
    assert.deepEqual(busy.notes, ["pr-poll"]);
  });

  it("reports busy, building and releasing nothing, when the lock stays held", () => {
    const { events, deps } = fakes({ take: () => false });
    assert.equal(buildNow("pr-poll", { ...deps, maxWaitMs: 200 }), "busy");
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

  it("ignores the tags file and the last bake, so recording a tag never costs a pass", () => {
    const root = tree();
    const before = buildInputs(root);
    recordTag("report-move", root);
    writeFileSync(join(root, "config", "last-built-state.json"), "{}");
    assert.equal(buildInputs(root), before);
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
    const notes: string[] = [];
    return {
      events,
      notes,
      deps: {
        note: (tag: string) => notes.push(tag),
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
        settle: () => {},
        hurry: () => events.push("hurry"),
        pause: () => events.push("pause"),
        maxWaitMs: 500,
      },
    };
  }

  it("waits on a held lock, then builds once and drops it", () => {
    let tries = 0;
    const { events, deps } = fakes({ take: () => ++tries > 2 });
    assert.equal(lockedBuild(deps), 0);
    // Hurries the waiting build once, on the first try that finds it held.
    assert.deepEqual(events, ["busy", "hurry", "pause", "busy", "pause", "take", "build", "release"]);
  });

  it("records its own tag for the build's log line", () => {
    const { notes, deps } = fakes();
    lockedBuild(deps);
    assert.deepEqual(notes, ["npm run build"]);
  });

  it("waits as long as a live build could hold the lock by default", () => {
    // A lock that never frees: count the pauses the default wait allows,
    // without any real sleeping.
    let paused = 0;
    const notes: string[] = [];
    const status = lockedBuild({
      take: () => false,
      note: (tag: string) => notes.push(tag),
      pause: (ms: number) => {
        paused += ms;
      },
    });
    assert.equal(status, 1);
    assert.ok(paused >= BUILD_LOCK_STALE_MS, `waited ${paused}ms`);
    // It built nothing, so no later build's line names it.
    assert.deepEqual(notes, []);
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

  it("never exceeds the gap, even with a redraw stamped in the future", () => {
    assert.equal(gapLeft(0, 600_000, 20_000), 20_000);
  });

  it("with the build's timeout, stays under the lock's stale threshold", () => {
    assert.ok(REDRAW_GAP_MS + BUILD_TIMEOUT_MS < BUILD_LOCK_STALE_MS);
  });

  it("orders the paces, and the slow gap and the build's timeout each stay under the stale threshold", () => {
    assert.ok(TAP_GAP_MS < REDRAW_GAP_MS && REDRAW_GAP_MS < SLOW_GAP_MS);
    assert.ok(Math.max(SLOW_GAP_MS, BUILD_TIMEOUT_MS) + COALESCE_MS < BUILD_LOCK_STALE_MS);
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
    settleGap({ now: c.now, lastRedraw: () => 0, urgent: () => false, soon: () => true, pause: c.pause });
    assert.deepEqual(c.pauses, [250, 250, 100]);
  });

  it("does not wait once the gap has passed", () => {
    const c = clock(SLOW_GAP_MS + 1);
    settleGap({ now: c.now, lastRedraw: () => 0, urgent: () => false, soon: () => false, pause: c.pause });
    assert.deepEqual(c.pauses, []);
  });

  it("cuts the wait to the tap gap once a tap raises the urgent flag", () => {
    const c = clock(0);
    settleGap({
      now: c.now,
      lastRedraw: () => 0,
      urgent: () => c.pauses.length === 2,
      soon: () => false,
      pause: c.pause,
    });
    assert.deepEqual(c.pauses, [250, 250, 250, 250]);
  });

  type Clock = ReturnType<typeof clock>;

  // How long a settle from a fresh redraw waits in all, starting from
  // `gap`, given when each flag reads as raised.
  function waited(gap: number, urgent: (c: Clock) => boolean, soon: (c: Clock) => boolean): number {
    const c = clock(0);
    settleGap({ now: c.now, lastRedraw: () => 0, urgent: () => urgent(c), soon: () => soon(c), pause: c.pause }, gap);
    return c.pauses.reduce((a, b) => a + b, 0);
  }
  const never = (): boolean => false;
  const at =
    (step: number) =>
    (c: Clock): boolean =>
      c.pauses.length === step;

  it("waits out its own pace's gap when no flag goes up", () => {
    assert.equal(waited(PACE_GAP.slow, never, never), SLOW_GAP_MS);
    assert.equal(waited(PACE_GAP.soon, never, never), REDRAW_GAP_MS);
    assert.equal(waited(PACE_GAP.tap, never, never), TAP_GAP_MS);
  });

  it("cuts a slow wait under way once the soon flag goes up, going at once past the usual gap", () => {
    // Raised 30 seconds in (120 steps of 250ms), already past the usual gap.
    assert.equal(waited(PACE_GAP.slow, never, at(120)), 30_000);
    assert.equal(waited(PACE_GAP.slow, never, at(0)), REDRAW_GAP_MS);
  });

  it("never lengthens a wait when a slower flag goes up after a faster one", () => {
    assert.equal(waited(PACE_GAP.slow, at(0), at(1)), TAP_GAP_MS);
  });

  it("takes down the soon flag even on the step the urgent one ends the wait", () => {
    const read: string[] = [];
    const c = clock(TAP_GAP_MS);
    settleGap({
      now: c.now,
      lastRedraw: () => 0,
      urgent: () => read.push("urgent") > 0,
      soon: () => read.push("soon") > 0,
      pause: c.pause,
    });
    assert.deepEqual(read, ["urgent", "soon"]);
  });

  it("raises the urgent flag for a tap, the soon flag for the usual pace, and none for slow", () => {
    assert.equal(flagFor("tap", "/r"), "/r/config/build-urgent");
    assert.equal(flagFor("soon", "/r"), "/r/config/build-soon");
    assert.equal(flagFor("slow", "/r"), null);
  });

  it("goes at once on a tap when the tap gap has already passed", () => {
    const c = clock(TAP_GAP_MS);
    settleGap({ now: c.now, lastRedraw: () => 0, urgent: () => true, soon: () => false, pause: c.pause });
    assert.deepEqual(c.pauses, []);
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

describe("recordTag and takeTags", () => {
  const dir = mkdtempSync(join(tmpdir(), "hook-build-tags-"));
  mkdirSync(join(dir, "config"));
  after(() => rmSync(dir, { recursive: true, force: true }));

  it("takes nothing when no write has recorded a tag", () => {
    assert.deepEqual(takeTags(dir), []);
  });

  it("takes every tag recorded since the last take, in order, repeats included", () => {
    recordTag("report-subagent", dir);
    recordTag("report-move", dir);
    recordTag("report-subagent", dir);
    assert.deepEqual(takeTags(dir), ["report-subagent", "report-move", "report-subagent"]);
    assert.deepEqual(takeTags(dir), []);
  });

  it("keeps a tag recorded after a take for the next one", () => {
    recordTag("state-set", dir);
    assert.deepEqual(takeTags(dir), ["state-set"]);
    recordTag("pr-poll", dir);
    assert.deepEqual(takeTags(dir), ["pr-poll"]);
  });

  it("never fails the write when the tag cannot be kept", () => {
    assert.doesNotThrow(() => recordTag("report-move", join(dir, "no-such-folder")));
    assert.deepEqual(takeTags(join(dir, "no-such-folder")), []);
  });
});

describe("changedKeys", () => {
  it("names the keys added, removed or changed, sorted", () => {
    const before = { prs: { a: 1 }, subagents: [1], dismissed: [] };
    const after = { prs: { a: 2 }, dismissed: [], poll: { at: 1 } };
    assert.deepEqual(changedKeys(before, after), ["poll", "prs", "subagents"]);
  });

  it("ignores the order of keys inside a value, at any depth", () => {
    const before = { prs: { a: { n: 1, s: "open" }, b: { n: 2, s: "draft" } } };
    const after = { prs: { b: { s: "draft", n: 2 }, a: { s: "open", n: 1 } } };
    assert.deepEqual(changedKeys(before, after), []);
  });

  it("still reads a reordered list as changed", () => {
    assert.deepEqual(changedKeys({ dismissed: ["a", "b"] }, { dismissed: ["b", "a"] }), ["dismissed"]);
  });

  it("names none when nothing changed", () => {
    assert.deepEqual(changedKeys({ prs: { a: 1 } }, { prs: { a: 1 } }), []);
  });

  it("counts every key as changed on a first build", () => {
    assert.deepEqual(changedKeys(null, { subagents: [], prs: {} }), ["prs", "subagents"]);
  });
});

describe("the late build for subagent runs", () => {
  it("counts as arranged until it could no longer be live", () => {
    assert.equal(lateBuildArranged(null, 1_000), false);
    assert.equal(lateBuildArranged(0, LATER_MS), true);
    assert.equal(lateBuildArranged(0, LATER_MS + BUILD_LOCK_STALE_MS - 1), true);
    assert.equal(lateBuildArranged(0, LATER_MS + BUILD_LOCK_STALE_MS), false, "a late build that died");
  });

  it("waits longer than the slow gap, outside the lock", () => {
    assert.ok(LATER_MS > SLOW_GAP_MS);
    assert.ok(LATER_MS > BUILD_LOCK_STALE_MS, "too long to wait while holding the lock");
  });
});
