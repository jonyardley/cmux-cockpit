import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { defaultBranchArgs, defaultFromGit, isDefaultBranch } from "../src/shared/default-branch.ts";

// The same cases as the Rust tests in native/core/src/pr_poll/gh.rs.
describe("default branch", () => {
  it("reads the default branch from git, or none", () => {
    const said = (stdout: string) => defaultFromGit({ status: 0, stdout });
    assert.equal(said("origin/main\n"), "main");
    assert.equal(said("origin/team/trunk\n"), "team/trunk");
    assert.equal(said("origin/\n"), null);
    assert.equal(said("upstream/main\n"), null);
    assert.equal(defaultFromGit({ status: 1, stdout: "" }), null, "no origin/HEAD");
    assert.equal(defaultFromGit({ status: null, stdout: "" }), null, "a timeout");
    assert.equal(defaultBranchArgs("/d").join(" "), "-C /d symbolic-ref --quiet --short refs/remotes/origin/HEAD");
  });

  it("is the named branch, else main or master", () => {
    assert.equal(isDefaultBranch("trunk", "trunk"), true);
    assert.equal(isDefaultBranch("main", "trunk"), false);
    assert.equal(isDefaultBranch("main", null), true);
    assert.equal(isDefaultBranch("master", null), true);
    assert.equal(isDefaultBranch("feat", null), false);
    assert.equal(isDefaultBranch("Main", null), false, "branch names are case sensitive");
  });
});
