// scripts/start-cockpit.sh, which the start-cockpit rule runs when cmux
// opens a window. Each case runs it with a fake HOME and a PATH of
// stand-ins: ps names cmux at pid 100, pgrep answers from files that say
// which Cockpit pid runs and whether its publisher does, pkill records
// how it was called and stops Cockpit (unless a case makes it stubborn,
// when only -9 does), open records the app and starts Cockpit at a new
// pid, and sleep returns at once.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

const SCRIPT = join(import.meta.dirname, "..", "scripts", "start-cockpit.sh");
// Real tools the script and the stand-ins use.
const TOOLS = ["grep", "head", "tr", "cut", "cat", "mkdir", "rm"];

let home = "";
let bin = "";
let app = "";
let state = "";
let calls = "";

function which(tool: string): string {
  const found = ["/usr/bin", "/bin"].map((d) => join(d, tool)).find((p) => existsSync(p));
  assert.ok(found, `${tool} not found in /usr/bin or /bin`);
  return found;
}

function stub(name: string, body: string): void {
  const path = join(bin, name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "start-cockpit-"));
  bin = join(home, "bin");
  mkdirSync(bin);
  for (const tool of TOOLS) symlinkSync(which(tool), join(bin, tool));
  app = join(home, "Cockpit.app");
  mkdirSync(app);
  state = join(home, "state");
  calls = join(home, "calls");
  const f = (name: string) => join(home, name);
  stub("ps", `echo "  99 /usr/sbin/cfprefsd"; echo "  100 /Applications/cmux.app/Contents/MacOS/cmux"`);
  stub(
    "pgrep",
    `case "$2" in
  Cockpit) [ -f "${f("running")}" ] && cat "${f("running")}" ;;
  cockpit-publish) [ -f "${f("publisher")}" ] ;;
  *) exit 1 ;;
esac`,
  );
  stub(
    "pkill",
    `echo "pkill $*" >> "${calls}"
if [ "$1" = -9 ] || [ ! -f "${f("stubborn")}" ]; then rm -f "${f("running")}"; fi
exit 0`,
  );
  stub(
    "open",
    `echo "open $1" >> "${calls}"
n=$(cat "${f("next")}" 2>/dev/null || echo 500)
echo "$n" > "${f("running")}"; echo $((n + 1)) > "${f("next")}"; : > "${f("publisher")}"`,
  );
  stub("sleep", "exit 0");
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

function run() {
  return spawnSync("/bin/sh", [SCRIPT], {
    encoding: "utf8",
    env: { HOME: home, PATH: bin, COCKPIT_APP: app, COCKPIT_STATE: state },
  });
}

/** A Cockpit at `pid`, with its publisher running unless told otherwise. */
function cockpitRunning(pid: number, publisher = true): void {
  writeFileSync(join(home, "running"), `${pid}\n`);
  if (publisher) writeFileSync(join(home, "publisher"), "");
}

function started(pair: string): void {
  mkdirSync(state, { recursive: true });
  writeFileSync(join(state, "started"), `${pair}\n`);
}

function log(): string[] {
  return existsSync(calls) ? readFileSync(calls, "utf8").trim().split("\n") : [];
}

function noted(): string {
  return readFileSync(join(state, "started"), "utf8").trim();
}

describe("start-cockpit.sh", () => {
  it("opens Cockpit when none is running, and notes this cmux started it", () => {
    assert.equal(run().status, 0);
    assert.deepEqual(log(), [`open ${app}`]);
    assert.equal(noted(), "100 500");
  });

  it("leaves alone the Cockpit this cmux started", () => {
    cockpitRunning(42);
    started("100 42");
    assert.equal(run().status, 0);
    assert.deepEqual(log(), []);
  });

  it("restarts a Cockpit started outside this cmux, as at login", () => {
    cockpitRunning(42);
    assert.equal(run().status, 0);
    assert.deepEqual(log(), ["pkill -x Cockpit", `open ${app}`]);
    assert.equal(noted(), "100 500");
  });

  it("restarts a Cockpit an earlier cmux started", () => {
    cockpitRunning(42);
    started("77 42");
    run();
    assert.deepEqual(log(), ["pkill -x Cockpit", `open ${app}`]);
    assert.equal(noted(), "100 500");
  });

  it("forces out a Cockpit that will not quit before opening another", () => {
    cockpitRunning(42);
    writeFileSync(join(home, "stubborn"), "");
    run();
    assert.deepEqual(log(), ["pkill -x Cockpit", "pkill -9 -x Cockpit", `open ${app}`]);
  });

  it("leaves a Cockpit without its publisher alone, as a fixture runs", () => {
    cockpitRunning(42, false);
    run();
    assert.deepEqual(log(), []);
  });

  it("does nothing while another copy holds the lock", () => {
    cockpitRunning(42);
    mkdirSync(join(state, "start.lock"), { recursive: true });
    writeFileSync(join(state, "start.lock", "pid"), `${process.pid}\n`);
    run();
    assert.deepEqual(log(), []);
  });

  it("takes over a lock its holder died with, and releases it", () => {
    cockpitRunning(42);
    mkdirSync(join(state, "start.lock"), { recursive: true });
    writeFileSync(join(state, "start.lock", "pid"), "999999\n");
    run();
    assert.deepEqual(log(), ["pkill -x Cockpit", `open ${app}`]);
    assert.ok(!existsSync(join(state, "start.lock")));
  });

  it("does nothing without a Cockpit build", () => {
    rmSync(app, { recursive: true });
    assert.equal(run().status, 0);
    assert.deepEqual(log(), []);
  });

  it("does nothing when it cannot find cmux", () => {
    stub("ps", 'echo "  99 /usr/sbin/cfprefsd"');
    cockpitRunning(42);
    assert.equal(run().status, 0);
    assert.deepEqual(log(), []);
  });
});
