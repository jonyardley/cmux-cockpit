// The PR poller (#7): reading cmux's and gh's output, choosing a branch's PR,
// building the saved map, and the `prs` map's contract in the state file.
// The cmux, git and gh subprocesses themselves are not covered.

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import {
  branchFromGit,
  checksFrom,
  findPrs,
  type Lookups,
  parseWindowIds,
  parseWorkspaces,
  pickPr,
} from "../scripts/pr-poll.ts";
import { applySet, emptyState, type SavedPr, validateState } from "../scripts/state-config.ts";
import { writePrs } from "../scripts/state-url.ts";

const url = (n: number) => `https://github.com/o/r/pull/${n}`;
const pr = (n: number, extra: Partial<SavedPr> = {}): SavedPr => ({
  number: n,
  url: url(n),
  status: "open",
  branch: "feat",
  ...extra,
});
const gh = (list: unknown[]) => JSON.stringify(list);
const ghPr = (n: number, state: string, updatedAt: string, headRefName = "feat") => ({
  number: n,
  state,
  url: url(n),
  headRefName,
  updatedAt,
});

describe("parseWindowIds and parseWorkspaces", () => {
  it("reads window ids, skipping malformed entries", () => {
    assert.deepEqual(parseWindowIds(JSON.stringify({ windows: [{ id: "w1" }, { ref: "x" }, 3] })), ["w1"]);
  });

  it("returns null for output it cannot read", () => {
    assert.equal(parseWindowIds("not json"), null);
    assert.equal(parseWindowIds("{}"), null);
    assert.equal(parseWorkspaces("[]"), null);
  });

  it("reads workspaces that have a directory", () => {
    const text = JSON.stringify({
      workspaces: [{ id: "a", current_directory: "/d/a" }, { id: "b", current_directory: "" }, { id: "c" }, null],
    });
    assert.deepEqual(parseWorkspaces(text), [{ id: "a", directory: "/d/a" }]);
  });
});

describe("pickPr", () => {
  it("prefers an open PR over a newer merged one", () => {
    const text = gh([ghPr(2, "MERGED", "2026-09-02"), ghPr(1, "OPEN", "2026-09-01")]);
    assert.deepEqual(pickPr(text, "feat"), pr(1));
  });

  it("otherwise takes the most recently updated", () => {
    const text = gh([ghPr(1, "CLOSED", "2026-09-01"), ghPr(2, "MERGED", "2026-09-03")]);
    assert.deepEqual(pickPr(text, "feat"), pr(2, { status: "merged" }));
  });

  it("ignores another branch's PR and unknown states", () => {
    const text = gh([ghPr(1, "OPEN", "2026-09-01", "other"), ghPr(2, "DRAFTY", "2026-09-01")]);
    assert.equal(pickPr(text, "feat"), null);
  });

  it("ignores a fork's PR (isCrossRepository)", () => {
    const text = gh([{ ...ghPr(1, "OPEN", "2026-09-01"), isCrossRepository: true }, ghPr(2, "OPEN", "2026-09-01")]);
    assert.deepEqual(pickPr(text, "feat"), pr(2));
  });

  it("returns undefined when gh's output cannot be read", () => {
    assert.equal(pickPr("oops", "feat"), undefined);
  });
});

const run = (
  name: string,
  status: string,
  conclusion: string,
  startedAt = "2026-09-27T09:00:00Z",
  workflowName = "CI",
) => ({
  __typename: "CheckRun",
  name,
  status,
  conclusion,
  startedAt,
  workflowName,
});

describe("checksFrom", () => {
  it("reads check runs in three states, sorted by name", () => {
    const rollup = [
      run("test", "IN_PROGRESS", ""),
      run("lint", "COMPLETED", "FAILURE"),
      run("build", "COMPLETED", "SUCCESS"),
      run("docs", "COMPLETED", "SKIPPED"),
      run("e2e", "COMPLETED", "CANCELLED"),
      run("deploy", "QUEUED", ""),
    ];
    assert.deepEqual(checksFrom(rollup), [
      { name: "e2e", state: "fail" },
      { name: "lint", state: "fail" },
      { name: "deploy", state: "pending" },
      { name: "test", state: "pending" },
      { name: "build", state: "pass" },
      { name: "docs", state: "pass" },
    ]);
  });

  it("reads commit statuses by their context", () => {
    const status = (context: string, state: string) => ({ __typename: "StatusContext", context, state });
    assert.deepEqual(
      checksFrom([status("a", "SUCCESS"), status("b", "PENDING"), status("c", "EXPECTED"), status("d", "ERROR")]),
      [
        { name: "d", state: "fail" },
        { name: "b", state: "pending" },
        { name: "c", state: "pending" },
        { name: "a", state: "pass" },
      ],
    );
  });

  it("keeps only the latest run of a rerun check", () => {
    const rollup = [
      run("pr-body", "COMPLETED", "FAILURE", "2026-09-27T09:05:10Z", "PR description"),
      run("pr-body", "COMPLETED", "SUCCESS", "2026-09-27T09:05:45Z", "PR description"),
      run("pr-body", "IN_PROGRESS", "", "2026-09-27T09:05:12Z", "Other"),
    ];
    assert.deepEqual(checksFrom(rollup), [
      { name: "pr-body", state: "pending" },
      { name: "pr-body", state: "pass" },
    ]);
  });

  it("counts a queued rerun with no start as the latest run", () => {
    for (const startedAt of ["", "0001-01-01T00:00:00Z"]) {
      const rollup = [
        run("build", "COMPLETED", "FAILURE", "2026-09-27T09:00:00Z"),
        run("build", "QUEUED", "", startedAt),
      ];
      assert.deepEqual(checksFrom(rollup), [{ name: "build", state: "pending" }]);
    }
  });

  it("skips malformed entries, caps the list and ignores a missing rollup", () => {
    assert.deepEqual(checksFrom([null, { name: "  " }, { __typename: "CheckRun" }, 3]), []);
    assert.deepEqual(checksFrom(undefined), []);
    const many = Array.from({ length: 30 }, (_, i) => run(`c${String(i).padStart(2, "0")}`, "COMPLETED", "SUCCESS"));
    assert.equal(checksFrom(many).length, 20);
    const lateRed = [...many, run("zz-lint", "COMPLETED", "FAILURE")];
    assert.deepEqual(checksFrom(lateRed)[0], { name: "zz-lint", state: "fail" });
  });
});

describe("pickPr with checks", () => {
  it("saves the chosen PR's checks, and none when it has none", () => {
    const rollup = [run("check", "COMPLETED", "SUCCESS")];
    const text = gh([{ ...ghPr(1, "OPEN", "2026-09-01"), statusCheckRollup: rollup }]);
    assert.deepEqual(pickPr(text, "feat"), pr(1, { checks: [{ name: "check", state: "pass" }] }));
    assert.deepEqual(pickPr(gh([{ ...ghPr(1, "OPEN", "2026-09-01"), statusCheckRollup: [] }]), "feat"), pr(1));
  });

  it("marks a draft, and leaves a ready PR's entry as it was", () => {
    assert.deepEqual(pickPr(gh([{ ...ghPr(1, "OPEN", "2026-09-01"), isDraft: true }]), "feat"), pr(1, { draft: true }));
    assert.deepEqual(pickPr(gh([{ ...ghPr(1, "OPEN", "2026-09-01"), isDraft: false }]), "feat"), pr(1));
  });
});

describe("the saved draft flag", () => {
  it("survives validation only as true", () => {
    const saved = (draft: unknown) => validateState({ prs: { w1: { ...pr(1), draft } } }).prs.w1;
    assert.deepEqual(saved(true), pr(1, { draft: true }));
    assert.deepEqual(saved(false), pr(1));
    assert.deepEqual(saved("yes"), pr(1));
  });
});

describe("branchFromGit", () => {
  it("reads the branch from a clean exit", () => {
    assert.equal(branchFromGit({ status: 0, stdout: "feat\n", stderr: "" }), "feat");
  });

  it("is null for a detached HEAD (clean exit, empty stdout)", () => {
    assert.equal(branchFromGit({ status: 0, stdout: "\n", stderr: "" }), null);
  });

  it("is null when the directory is not a repo", () => {
    assert.equal(branchFromGit({ status: 128, stdout: "", stderr: "fatal: not a git repository\n" }), null);
  });

  it("is undefined when git failed for another reason", () => {
    assert.equal(branchFromGit({ status: 128, stdout: "", stderr: "fatal: something else\n" }), undefined);
  });

  it("is undefined when git was killed (a timeout has status null)", () => {
    assert.equal(branchFromGit({ status: null, stdout: "", stderr: "" }), undefined);
  });
});

describe("findPrs", () => {
  const ws = (id: string, directory = "/d/app") => ({ id, directory });

  it("asks once per directory and branch, and gives every workspace there the PR", () => {
    let asked = 0;
    const look: Lookups = {
      branchOf: () => "feat",
      prFor: () => {
        asked++;
        return pr(1);
      },
    };
    assert.deepEqual(findPrs([ws("a"), ws("b")], {}, look), { a: pr(1), b: pr(1) });
    assert.equal(asked, 1);
  });

  it("skips a directory with no branch and drops a PR that has gone", () => {
    const look: Lookups = { branchOf: (d) => (d === "/d/app" ? "feat" : null), prFor: () => null };
    assert.deepEqual(findPrs([ws("a"), ws("b", "/d/none")], { a: pr(1) }, look), {});
  });

  it("keeps the previous PR when gh fails, but only for the same branch", () => {
    const look: Lookups = { branchOf: (d) => (d === "/d/app" ? "feat" : "main"), prFor: () => undefined };
    const previous = { a: pr(1), b: pr(2) };
    assert.deepEqual(findPrs([ws("a"), ws("b", "/d/other"), ws("gone")], previous, look), { a: pr(1) });
  });

  it("keeps the previous PR as-is when git itself failed, regardless of branch", () => {
    const look: Lookups = { branchOf: () => undefined, prFor: () => pr(9) };
    const previous = { a: pr(1, { branch: "other" }) };
    assert.deepEqual(findPrs([ws("a")], previous, look), { a: pr(1, { branch: "other" }) });
  });

  it("drops the workspace when the directory is not a repo (branchOf null)", () => {
    const look: Lookups = { branchOf: () => null, prFor: () => pr(9) };
    assert.deepEqual(findPrs([ws("a")], { a: pr(1) }, look), {});
  });
});

describe("the prs map in state.json", () => {
  it("keeps a valid PR and drops bad urls, statuses, numbers and branches", () => {
    const raw = {
      prs: {
        ok: pr(1),
        js: pr(2, { url: "javascript:alert(1)" }),
        other: pr(3, { url: "https://evil.example/o/r/pull/3" }),
        status: { ...pr(4), status: "draft" },
        number: pr(0),
        branch: pr(5, { branch: "" }),
        shape: "x",
      },
    };
    assert.deepEqual(validateState(raw).prs, { ok: pr(1) });
  });

  it("keeps valid checks, drops bad ones, and leaves out an empty list", () => {
    const checks = [
      { name: "ok", state: "pass" },
      { name: "odd", state: "skipped" },
      { name: " padded", state: "fail" },
      { name: "x".repeat(65), state: "fail" },
      "bad",
    ];
    assert.deepEqual(
      validateState({ prs: { a: { ...pr(1), checks } } }).prs.a,
      pr(1, { checks: [{ name: "ok", state: "pass" }] }),
    );
    assert.deepEqual(validateState({ prs: { a: { ...pr(1), checks: [] } } }).prs.a, pr(1));
    assert.deepEqual(validateState({ prs: { a: { ...pr(1), checks: "x" } } }).prs.a, pr(1));
  });

  it("cannot be set by a URL", () => {
    const set = applySet(emptyState(), "prs.w1", JSON.stringify(pr(1)));
    assert.deepEqual(set, { ok: false, error: "unknown map prs" });
  });

  const dir = mkdtempSync(join(tmpdir(), "pr-poll-"));
  after(() => rmSync(dir, { recursive: true, force: true }));

  it("writePrs replaces the map, keeps the other maps, and says when nothing changed", () => {
    const path = join(dir, "state.json");
    assert.deepEqual(writePrs(path, { a: pr(1) }), { ok: true, changed: true });
    const written = JSON.parse(readFileSync(path, "utf8"));
    assert.deepEqual(written, { ...emptyState(), prs: { a: pr(1) } });
    assert.deepEqual(writePrs(path, { a: pr(1) }), { ok: true, changed: false });
    assert.deepEqual(writePrs(path, {}), { ok: true, changed: true });
  });

  it("is a change only when a check's state changes", () => {
    const path = join(dir, "state-checks.json");
    const withCheck = (state: "pass" | "pending") => ({ a: pr(1, { checks: [{ name: "ci", state }] }) });
    assert.deepEqual(writePrs(path, withCheck("pending")), { ok: true, changed: true });
    assert.deepEqual(writePrs(path, withCheck("pending")), { ok: true, changed: false });
    assert.deepEqual(writePrs(path, withCheck("pass")), { ok: true, changed: true });
  });

  it("is order-insensitive: the same entries in a different key order are not a change", () => {
    const path = join(dir, "state-order.json");
    assert.deepEqual(writePrs(path, { b: pr(2, { branch: "b" }), a: pr(1) }), { ok: true, changed: true });
    assert.deepEqual(writePrs(path, { a: pr(1), b: pr(2, { branch: "b" }) }), { ok: true, changed: false });
  });
});
