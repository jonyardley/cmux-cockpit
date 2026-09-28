// The guard before `gh pr ready`: which commands it reads as going ready,
// which PR, and from which directory. The gh lookup itself is not run here.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";
import { readyCall } from "../scripts/hooks/guard-ready.ts";

const bash = (command: string, cwd = "/repo") => ({ tool_name: "Bash", tool_input: { command }, cwd });

describe("readyCall", () => {
  it("reads a bare gh pr ready as the current branch's PR, in the event's directory", () => {
    assert.deepEqual(readyCall(bash("gh pr ready")), { pr: null, cwd: "/repo" });
  });

  it("takes the PR a number or URL names, past flags", () => {
    assert.deepEqual(readyCall(bash("gh pr ready 90")), { pr: "90", cwd: "/repo" });
    assert.deepEqual(readyCall(bash("gh -R o/r pr ready https://github.com/o/r/pull/9")), {
      pr: "https://github.com/o/r/pull/9",
      cwd: "/repo",
    });
  });

  it("runs from an absolute cd earlier in the command, and counts an rtk prefix", () => {
    assert.deepEqual(readyCall(bash("cd /wt/branch && rtk gh pr ready")), { pr: null, cwd: "/wt/branch" });
  });

  it("ignores a relative cd, since it cannot say where that lands", () => {
    assert.deepEqual(readyCall(bash("cd wt && gh pr ready")), { pr: null, cwd: "/repo" });
  });

  it("finds it after other commands in the same call", () => {
    assert.deepEqual(readyCall(bash("npm run check && gh pr ready 5")), { pr: "5", cwd: "/repo" });
  });

  it("lets --undo, other gh commands, mentions and other tools through", () => {
    assert.equal(readyCall(bash("gh pr ready --undo")), null);
    assert.equal(readyCall(bash("gh pr view 90")), null);
    assert.equal(readyCall(bash("gh pr ready-ish")), null);
    assert.equal(readyCall(bash('echo "then gh pr ready"')), null);
    assert.equal(readyCall({ tool_name: "Edit", tool_input: { command: "gh pr ready" } }), null);
    assert.equal(readyCall(null), null);
  });
});

describe("guard-ready as a hook", () => {
  const run = (stdin: string) => spawnSync(process.execPath, ["scripts/hooks/guard-ready.ts"], { input: stdin }).status;

  it("lets a call through that runs no gh pr ready", () => {
    assert.equal(run(JSON.stringify(bash("ls"))), 0);
  });

  it("refuses on input it cannot parse, rather than failing open", () => {
    assert.equal(run("not json"), 2);
  });
});
