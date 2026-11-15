// scripts/find-node.sh, the one list of places the helper app and
// pr-poll.sh look for node. Each case runs it with a fake HOME holding one
// manager's layout and a PATH stripped to the few tools the script needs,
// so the real machine's node (on PATH, in Homebrew or a CI runner's
// /usr/local/bin) never answers for it.

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
import { homedir, tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { LOG_PATH } from "../scripts/state-log.ts";

const FINDER = join(import.meta.dirname, "..", "scripts", "find-node.sh");
const POLL = join(import.meta.dirname, "..", "scripts", "pr-poll.sh");
// What the scripts shell out to; everything else is a shell builtin.
const TOOLS = ["sort", "tail", "date", "dirname"];

let home = "";
let bin = "";

function which(tool: string): string {
  const found = ["/usr/bin", "/bin"].map((d) => join(d, tool)).find((p) => existsSync(p));
  assert.ok(found, `${tool} not found in /usr/bin or /bin`);
  return found;
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "find-node-"));
  bin = join(home, "stripped-bin");
  mkdirSync(bin);
  for (const tool of TOOLS) symlinkSync(which(tool), join(bin, tool));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

/** Makes an executable stand-in for node at `rel` under HOME, returning its path. */
function fakeNode(rel: string): string {
  const path = join(home, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "#!/bin/sh\n");
  chmodSync(path, 0o755);
  return path;
}

function run(script: string, env: Record<string, string> = {}) {
  return spawnSync("/bin/sh", [script], {
    encoding: "utf8",
    env: { HOME: home, PATH: bin, CMUX_COCKPIT_FIXED_NODES: "", ...env },
  });
}

function finds(expected: string, env: Record<string, string> = {}): void {
  const r = run(FINDER, env);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, `${expected}\n`);
}

describe("find-node.sh", () => {
  it("prefers node on PATH", () => {
    fakeNode(".local/share/fnm/aliases/default/bin/node");
    const onPath = join(bin, "node");
    writeFileSync(onPath, "#!/bin/sh\n");
    chmodSync(onPath, 0o755);
    finds(onPath);
  });

  it("finds fnm's default alias, before nvm", () => {
    const fnm = fakeNode(".local/share/fnm/aliases/default/bin/node");
    fakeNode(".nvm/versions/node/v24.2.0/bin/node");
    finds(fnm);
  });

  it("finds fnm under FNM_DIR and under Application Support", () => {
    const custom = fakeNode("fnm-home/aliases/default/bin/node");
    finds(custom, { FNM_DIR: join(home, "fnm-home") });
    rmSync(join(home, "fnm-home"), { recursive: true });
    finds(fakeNode("Library/Application Support/fnm/aliases/default/bin/node"));
  });

  it("finds nvm's latest installed version, comparing the numbers", () => {
    fakeNode(".nvm/versions/node/v22.9.0/bin/node");
    fakeNode(".nvm/versions/node/v24.9.1/bin/node");
    const latest = fakeNode(".nvm/versions/node/v24.10.0/bin/node");
    finds(latest);
  });

  it("prefers nvm's default alias when it names an installed version", () => {
    const pinned = fakeNode(".nvm/versions/node/v22.9.0/bin/node");
    fakeNode(".nvm/versions/node/v22.1.0/bin/node");
    fakeNode(".nvm/versions/node/v24.10.0/bin/node");
    mkdirSync(join(home, ".nvm", "alias"), { recursive: true });
    writeFileSync(join(home, ".nvm", "alias", "default"), "22\n");
    finds(pinned);
    writeFileSync(join(home, ".nvm", "alias", "default"), "v22.1.0");
    finds(join(home, ".nvm/versions/node/v22.1.0/bin/node"));
  });

  it("falls back to nvm's latest for an alias only nvm can resolve", () => {
    const latest = fakeNode("nvm-home/versions/node/v24.10.0/bin/node");
    fakeNode("nvm-home/versions/node/v22.9.0/bin/node");
    mkdirSync(join(home, "nvm-home", "alias"), { recursive: true });
    writeFileSync(join(home, "nvm-home", "alias", "default"), "lts/*\n");
    finds(latest, { NVM_DIR: join(home, "nvm-home") });
  });

  it("finds volta", () => {
    finds(fakeNode(".volta/bin/node"));
  });

  it("finds asdf's latest installed version", () => {
    fakeNode(".asdf/installs/nodejs/22.11.0/bin/node");
    finds(fakeNode(".asdf/installs/nodejs/24.2.0/bin/node"));
  });

  it("finds mise's latest installed version", () => {
    fakeNode(".local/share/mise/installs/node/22.11.0/bin/node");
    finds(fakeNode(".local/share/mise/installs/node/24.2.0/bin/node"));
  });

  it("falls back to the fixed Homebrew paths", () => {
    const brew = fakeNode("homebrew/bin/node");
    finds(brew, { CMUX_COCKPIT_FIXED_NODES: `${join(home, "missing", "node")} ${brew}` });
  });

  it("logs a line to the state log and fails when there is no node anywhere", () => {
    mkdirSync(join(home, "Library", "Logs"), { recursive: true });
    const r = run(FINDER);
    assert.equal(r.status, 1);
    assert.equal(r.stdout, "");
    const log = readFileSync(join(home, "Library", "Logs", "cmux-cockpit-state.log"), "utf8");
    assert.match(log, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z find-node error: no node found .+\n$/);
  });
});

describe("find-node.sh's log", () => {
  it("is state-log.ts's LOG_PATH, under HOME", () => {
    const rel = relative(homedir(), LOG_PATH);
    assert.ok(readFileSync(FINDER, "utf8").includes(`"$HOME/${rel}"`));
  });
});

describe("pr-poll.sh", () => {
  it("does nothing and still exits 0 when the finder finds no node", () => {
    mkdirSync(join(home, "Library", "Logs"), { recursive: true });
    const r = run(POLL);
    assert.equal(r.status, 0, r.stderr);
    assert.match(readFileSync(join(home, "Library", "Logs", "cmux-cockpit-state.log"), "utf8"), /find-node error/);
  });

  it("runs pr-poll.ts with the node the finder found", () => {
    // A stand-in node that says what it was asked to run, instead of polling.
    const node = fakeNode(".volta/bin/node");
    writeFileSync(node, '#!/bin/sh\nprintf "%s\\n" "$@"\n');
    const r = run(POLL);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /scripts\/pr-poll\.ts\n$/);
  });
});
