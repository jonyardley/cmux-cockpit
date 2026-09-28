// The guard before `gh pr ready`: which commands it reads as going ready,
// which PR in which repo, from which directory, and whether the PR is this
// repo's. The gh lookup itself is not run here.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { isOurs, readyCall } from "../scripts/hooks/guard-ready.ts";

const bash = (command: string, cwd = "/repo") => ({ tool_name: "Bash", tool_input: { command }, cwd });
const call = (pr: string | null, cwd = "/repo", repo: string | null = null) => ({ pr, repo, cwd });

describe("readyCall", () => {
  it("reads a bare gh pr ready as the current branch's PR, in the event's directory", () => {
    assert.deepEqual(readyCall(bash("gh pr ready")), call(null));
  });

  it("takes the PR a number or URL names", () => {
    assert.deepEqual(readyCall(bash("gh pr ready 90")), call("90"));
    assert.deepEqual(
      readyCall(bash("gh pr ready https://github.com/o/r/pull/9")),
      call("https://github.com/o/r/pull/9"),
    );
    assert.deepEqual(readyCall(bash('gh pr ready "90"')), call("90"));
  });

  it("takes the repo from -R, --repo, --repo= or GH_REPO, never as the PR", () => {
    assert.deepEqual(readyCall(bash("gh pr ready --repo o/r 92")), call("92", "/repo", "o/r"));
    assert.deepEqual(readyCall(bash("gh pr ready --repo=o/r 92")), call("92", "/repo", "o/r"));
    assert.deepEqual(readyCall(bash("gh -R o/r pr ready 9")), call("9", "/repo", "o/r"));
    assert.deepEqual(readyCall(bash("GH_REPO=o/r gh pr ready 9")), call("9", "/repo", "o/r"));
  });

  it("stops at a redirection or background marker", () => {
    assert.deepEqual(readyCall(bash("gh pr ready 2>&1 | tail -3")), call(null));
    assert.deepEqual(readyCall(bash("gh pr ready > /dev/null")), call(null));
    assert.deepEqual(readyCall(bash("gh pr ready 7 &")), call("7"));
  });

  it("follows cd: absolute, relative to where it is, and from home", () => {
    assert.deepEqual(readyCall(bash("cd /wt/branch && rtk gh pr ready")), call(null, "/wt/branch"));
    assert.deepEqual(readyCall(bash("cd ../b && gh pr ready", "/wt/a")), call(null, "/wt/b"));
    assert.deepEqual(readyCall(bash("cd ~/x && gh pr ready")), call(null, join(homedir(), "x")));
  });

  it("finds it after other commands in the same call", () => {
    assert.deepEqual(readyCall(bash("npm run check && gh pr ready 5")), call("5"));
  });

  it("lets --undo, other gh commands, quoted mentions and other tools through", () => {
    assert.equal(readyCall(bash("gh pr ready --undo")), null);
    assert.equal(readyCall(bash("gh pr view 90")), null);
    assert.equal(readyCall(bash("gh pr ready-ish")), null);
    assert.equal(readyCall(bash('echo "then gh pr ready"')), null);
    assert.equal(readyCall(bash('gh pr comment 92 --body "fixed; gh pr ready next"')), null);
    assert.equal(readyCall({ tool_name: "Edit", tool_input: { command: "gh pr ready" } }), null);
    assert.equal(readyCall(null), null);
  });
});

describe("isOurs", () => {
  const checkout = (name: string) => {
    const dir = mkdtempSync(join(tmpdir(), "ready-"));
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name }));
    return dir;
  };

  it("judges a URL by its repo", () => {
    assert.equal(isOurs(call("https://github.com/jonyardley/cmux-cockpit/pull/92")), true);
    assert.equal(isOurs(call("https://github.com/jonyardley/other-repo/pull/5")), false);
  });

  it("judges a repo flag by its name", () => {
    assert.equal(isOurs(call("9", "/repo", "jonyardley/cmux-cockpit")), true);
    assert.equal(isOurs(call("9", "/repo", "jonyardley/other-repo")), false);
  });

  it("otherwise judges by the checkout it runs in", () => {
    assert.equal(isOurs(call(null, checkout("cmux-cockpit"))), true);
    assert.equal(isOurs(call("90", checkout("other-repo"))), false);
  });
});

describe("guard-ready as a hook", () => {
  const run = (script: string, stdin: string) => spawnSync("sh", ["-c", script], { input: stdin }).status;
  const node = `"${process.execPath}" scripts/hooks/guard-ready.ts`;

  it("lets a call through that runs no gh pr ready, before and after the shell filter", () => {
    assert.equal(run("sh scripts/hooks/guard-ready.sh", JSON.stringify(bash("ls"))), 0);
    assert.equal(run(node, JSON.stringify(bash("ls"))), 0);
  });

  it("lets another repo's ready through without asking gh", () => {
    assert.equal(run(node, JSON.stringify(bash("gh pr ready https://github.com/o/other-repo/pull/5"))), 0);
  });

  it("refuses on input it cannot parse, rather than failing open", () => {
    assert.equal(run(node, "gh pr ready: not json"), 2);
    assert.equal(run("sh scripts/hooks/guard-ready.sh", "gh pr ready: not json"), 2);
  });
});
