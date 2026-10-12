// scripts/start-cockpit.sh, which the start-cockpit rule runs when cmux
// opens a window. Each case runs it with a fake HOME and a PATH of
// stand-ins: pgrep answers from a file that says whether Cockpit runs,
// pkill removes it, open records the app it was asked for and starts
// Cockpit, and sleep returns at once, writing the next data.json (dated
// ahead, so it is newer than the script's mark) when a case lines one up.

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
const TOOLS = ["grep", "mktemp", "rm", "cp", "touch"];

const HEALTHY = '{"data":{"epoch":1,"workspaces":[{"id":"A"}]}}';
const REFUSED = '{"data":{"epoch":1,"workspaces":null}}';

let home = "";
let bin = "";
let app = "";
let data = "";
let running = "";
let opened = "";
let next = "";

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
  data = join(home, "data.json");
  running = join(home, "running");
  opened = join(home, "opened");
  next = join(home, "next.json");
  stub("pgrep", `[ -f "${running}" ]`);
  stub("pkill", `rm -f "${running}"`);
  stub("open", `echo "$1" >> "${opened}"; : > "${running}"`);
  stub("sleep", `[ -f "${next}" ] && cp "${next}" "${data}" && touch -t 203001010000 "${data}"; exit 0`);
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

function run(env: Record<string, string> = {}) {
  return spawnSync("/bin/sh", [SCRIPT], {
    encoding: "utf8",
    env: {
      HOME: home,
      PATH: bin,
      TMPDIR: home,
      COCKPIT_APP: app,
      COCKPIT_DATA: data,
      COCKPIT_WAIT: "3",
      ...env,
    },
  });
}

function opens(): string[] {
  return existsSync(opened) ? readFileSync(opened, "utf8").trim().split("\n") : [];
}

describe("start-cockpit.sh", () => {
  it("opens Cockpit when none is running", () => {
    const out = run();
    assert.equal(out.status, 0);
    assert.deepEqual(opens(), [app]);
  });

  it("leaves a Cockpit alone once it writes a workspace list", () => {
    writeFileSync(running, "");
    writeFileSync(data, REFUSED);
    writeFileSync(next, HEALTHY);
    const out = run();
    assert.equal(out.status, 0);
    assert.deepEqual(opens(), []);
    assert.ok(existsSync(running));
  });

  it("starts Cockpit again when its fresh data has no workspaces", () => {
    writeFileSync(running, "");
    writeFileSync(data, REFUSED);
    writeFileSync(next, REFUSED);
    const out = run();
    assert.equal(out.status, 0);
    assert.deepEqual(opens(), [app]);
    assert.ok(existsSync(running));
  });

  it("does not trust a list written before it began", () => {
    // A data.json left from before a reboot still lists workspaces.
    writeFileSync(running, "");
    writeFileSync(data, HEALTHY);
    touchPast(data);
    const out = run();
    assert.equal(out.status, 0);
    assert.deepEqual(opens(), [app]);
  });

  it("does nothing without a Cockpit build", () => {
    rmSync(app, { recursive: true });
    const out = run();
    assert.equal(out.status, 0);
    assert.deepEqual(opens(), []);
  });

  it("leaves no mark behind", () => {
    writeFileSync(running, "");
    writeFileSync(data, REFUSED);
    writeFileSync(next, HEALTHY);
    run();
    const left = spawnSync("/bin/ls", [home], { encoding: "utf8" }).stdout;
    assert.doesNotMatch(left, /start-cockpit\./);
  });
});

function touchPast(path: string): void {
  const out = spawnSync(which("touch"), ["-t", "202001010000", path]);
  assert.equal(out.status, 0);
}
