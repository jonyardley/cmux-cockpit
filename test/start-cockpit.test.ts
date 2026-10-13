// scripts/start-cockpit.sh, which the start-cockpit rule runs when cmux
// opens a window. Each case runs it with a fake HOME and a PATH of
// stand-ins: ps names cmux among the processes and, asked for the
// publisher's environment, shows the terminal pass when the running
// Cockpit has one; pgrep answers from files that say which Cockpit pid
// runs and whether its publisher does (always pid 43); pkill records how it was called
// and stops Cockpit (unless a case makes it stubborn, when only -9 does);
// cmux records the tab it is asked for and starts Cockpit with the pass,
// unless a case makes it refuse; and sleep returns at once.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

const SCRIPT = join(import.meta.dirname, "..", "scripts", "start-cockpit.sh");
// Real tools the script and the stand-ins use.
const TOOLS = ["grep", "head", "sed", "cat", "mkdir", "rm", "printf", "id"];

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
  stub(
    "ps",
    `if [ "$1" = -E ]; then
  [ "$3" = 43 ] || exit 1
  echo "/x/cockpit-publish --parent 42 HOME=/h$([ -f "${f("pass")}" ] && echo " CMUX_SOCKET_CAPABILITY=v1.x")"
else
  echo "/usr/sbin/cfprefsd"; echo "/Applications/cmux.app/Contents/MacOS/cmux"
fi`,
  );
  stub(
    "pgrep",
    `case "$2" in
  Cockpit) [ -f "${f("running")}" ] && cat "${f("running")}" ;;
  cockpit-publish) [ -f "${f("publisher")}" ] && echo 43 ;;
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
    "cmux",
    `echo "cmux $*" >> "${calls}"
[ -f "${f("refuses")}" ] && exit 1
n=$(cat "${f("next")}" 2>/dev/null || echo 500)
echo "$n" > "${f("running")}"; echo $((n + 1)) > "${f("next")}"
: > "${f("publisher")}"; : > "${f("pass")}"`,
  );
  stub("sleep", "exit 0");
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

function run(event = '{"name":"window.created","window_id":"W1"}') {
  return spawnSync("/bin/sh", [SCRIPT], {
    encoding: "utf8",
    env: {
      HOME: home,
      PATH: bin,
      COCKPIT_APP: app,
      COCKPIT_STATE: state,
      CMUX_AUTOMATION_EVENT_JSON: event,
    },
  });
}

/**
 * A Cockpit at `pid`, with its publisher running unless told otherwise,
 * and holding a cmux terminal's pass when `pass` is set.
 */
function cockpitRunning(pid: number, { publisher = true, pass = false } = {}): void {
  writeFileSync(join(home, "running"), `${pid}\n`);
  if (publisher) writeFileSync(join(home, "publisher"), "");
  if (pass) writeFileSync(join(home, "pass"), "");
}

function log(): string[] {
  return existsSync(calls) ? readFileSync(calls, "utf8").trim().split("\n") : [];
}

/** The tab start-cockpit asks cmux for, in window `window` if given. */
function tab(window = "W1", path = app): string {
  const where = window ? `--window ${window} ` : "";
  return `cmux new-surface --type terminal ${where}--focus false --command open '${path}'; exit`;
}

describe("start-cockpit.sh", () => {
  it("opens Cockpit from a background cmux tab in the new window", () => {
    assert.equal(run().status, 0);
    assert.deepEqual(log(), [tab()]);
  });

  it("asks for the tab without a window when the event names none", () => {
    run("{}");
    assert.deepEqual(log(), [tab("")]);
  });

  it("reads a window id written with spaces", () => {
    run('{"name": "window.created", "window_id": "W2"}');
    assert.deepEqual(log(), [tab("W2")]);
  });

  it("escapes a quote in the app's path for the tab's shell", () => {
    const odd = join(home, "o'neil", "Cockpit.app");
    mkdirSync(odd, { recursive: true });
    spawnSync("/bin/sh", [SCRIPT], {
      env: {
        HOME: home,
        PATH: bin,
        COCKPIT_APP: odd,
        COCKPIT_STATE: state,
        CMUX_AUTOMATION_EVENT_JSON: "{}",
      },
    });
    assert.deepEqual(log(), [tab("", odd.replace("'", "'\\''"))]);
  });

  it("opens nothing when cmux will not open the tab", () => {
    writeFileSync(join(home, "refuses"), "");
    assert.equal(run().status, 0);
    assert.deepEqual(log(), [tab()]);
    assert.ok(!existsSync(join(home, "running")));
  });

  it("finds the CLI beside the running app when PATH has none", () => {
    const where = join(home, "Apps", "cmux.app", "Contents");
    mkdirSync(join(where, "Resources", "bin"), { recursive: true });
    renameSync(join(bin, "cmux"), join(where, "Resources", "bin", "cmux"));
    stub("ps", `echo "${join(where, "MacOS", "cmux")}"`);
    run();
    assert.deepEqual(log(), [tab()]);
  });

  it("leaves alone a Cockpit whose publisher holds a cmux pass", () => {
    cockpitRunning(42, { pass: true });
    assert.equal(run().status, 0);
    assert.deepEqual(log(), []);
  });

  it("restarts a Cockpit without a pass, as one opened at login", () => {
    cockpitRunning(42);
    assert.equal(run().status, 0);
    assert.deepEqual(log(), ["pkill -x Cockpit", tab()]);
  });

  it("forces out a Cockpit that will not quit before opening another", () => {
    cockpitRunning(42);
    writeFileSync(join(home, "stubborn"), "");
    run();
    assert.deepEqual(log(), ["pkill -x Cockpit", "pkill -9 -x Cockpit", tab()]);
  });

  it("leaves a Cockpit without its publisher alone, as a fixture runs", () => {
    cockpitRunning(42, { publisher: false });
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
    assert.deepEqual(log(), ["pkill -x Cockpit", tab()]);
    assert.ok(!existsSync(join(state, "start.lock")));
  });

  it("does nothing without a Cockpit build", () => {
    rmSync(app, { recursive: true });
    assert.equal(run().status, 0);
    assert.deepEqual(log(), []);
  });

  it("does nothing when it cannot find cmux", () => {
    stub("ps", 'echo "/usr/sbin/cfprefsd"');
    cockpitRunning(42);
    assert.equal(run().status, 0);
    assert.deepEqual(log(), []);
  });
});
