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
  cleanTitle,
  delayFrom,
  findOwnPrs,
  findPrs,
  ghOutcome,
  type Lookups,
  lockWithin,
  nextPoll,
  type OwnLookups,
  ownPrsFrom,
  parseWindowIds,
  parseWorkspaces,
  pickPr,
  writePollState,
} from "../scripts/pr-poll.ts";
import { applySet, emptyState, type SavedOwnPr, type SavedPr, validateState } from "../scripts/state-config.ts";
import { writePrs, writeSubagents } from "../scripts/state-url.ts";

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

  it("marks mergeable only on GitHub's CLEAN verdict", () => {
    const merge = (mergeStateStatus: unknown) =>
      pickPr(gh([{ ...ghPr(1, "OPEN", "2026-09-01"), mergeStateStatus }]), "feat");
    assert.deepEqual(merge("CLEAN"), pr(1, { mergeable: true }));
    for (const v of ["BLOCKED", "UNSTABLE", "BEHIND", "UNKNOWN", undefined]) assert.deepEqual(merge(v), pr(1));
  });

  it("marks conflicts only on GitHub's DIRTY verdict", () => {
    const merge = (mergeStateStatus: unknown) =>
      pickPr(gh([{ ...ghPr(1, "OPEN", "2026-09-01"), mergeStateStatus }]), "feat");
    assert.deepEqual(merge("DIRTY"), pr(1, { conflicts: true }));
    for (const v of ["CLEAN", "BLOCKED", "UNSTABLE", "BEHIND", "UNKNOWN", undefined])
      assert.equal(merge(v)?.conflicts, undefined);
  });

  it("keeps the PR's title, cleaned, and leaves it out when nothing readable is left", () => {
    const titled = (title: unknown) => pickPr(gh([{ ...ghPr(1, "OPEN", "2026-09-01"), title }]), "feat");
    assert.deepEqual(titled("  Show\tthe PR title\n"), pr(1, { title: "Show the PR title" }));
    assert.equal(titled("x".repeat(500))?.title?.length, 120);
    for (const v of [" \n ", 5, undefined]) assert.deepEqual(titled(v), pr(1));
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

describe("the saved conflicts flag and title", () => {
  it("keeps conflicts only as true", () => {
    const saved = (conflicts: unknown) => validateState({ prs: { w1: { ...pr(1), conflicts } } }).prs.w1;
    assert.deepEqual(saved(true), pr(1, { conflicts: true }));
    assert.deepEqual(saved(false), pr(1));
    assert.deepEqual(saved("DIRTY"), pr(1));
  });

  it("keeps a title only as a clean label", () => {
    const saved = (title: unknown) => validateState({ prs: { w1: { ...pr(1), title } } }).prs.w1;
    assert.deepEqual(saved("Fix the hook"), pr(1, { title: "Fix the hook" }));
    for (const v of ["", " padded ", "a\nb", "x".repeat(121), 5]) assert.deepEqual(saved(v), pr(1));
  });
});

describe("the saved mergeable flag", () => {
  it("survives validation only as true", () => {
    const saved = (mergeable: unknown) => validateState({ prs: { w1: { ...pr(1), mergeable } } }).prs.w1;
    assert.deepEqual(saved(true), pr(1, { mergeable: true }));
    assert.deepEqual(saved(false), pr(1));
    assert.deepEqual(saved("CLEAN"), pr(1));
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

const own = (n: number, extra: Partial<SavedOwnPr> = {}): SavedOwnPr => ({
  number: n,
  url: url(n),
  status: "open",
  branch: "feat",
  title: "PR " + n,
  repo: "/a/.git",
  ...extra,
});

describe("ownPrsFrom", () => {
  const listed = (n: number, extra: Record<string, unknown> = {}) => ({
    ...ghPr(n, "OPEN", "t"),
    title: "PR " + n,
    ...extra,
  });

  it("keeps open PRs keyed by url, with title, draft and repo, and nothing CI says", () => {
    const rollup = [{ __typename: "CheckRun", name: "ci", status: "COMPLETED", conclusion: "SUCCESS" }];
    const text = gh([
      listed(1, { isDraft: true }),
      listed(2, { mergeStateStatus: "CLEAN", statusCheckRollup: rollup }),
    ]);
    assert.deepEqual(ownPrsFrom(text, "/a/.git"), { [url(1)]: own(1, { draft: true }), [url(2)]: own(2) });
  });

  it("keeps a fork's PR, since it is still Jon's", () => {
    assert.deepEqual(Object.keys(ownPrsFrom(gh([listed(1, { isCrossRepository: true })]), "/a/.git") ?? {}), [url(1)]);
  });

  it("drops closed, merged and malformed entries", () => {
    const text = gh([listed(1, { state: "MERGED" }), listed(2, { state: "CLOSED" }), { number: 3 }, "x", listed(4)]);
    assert.deepEqual(Object.keys(ownPrsFrom(text, "/a/.git") ?? {}), [url(4)]);
  });

  it("titles a PR with no readable title by its branch", () => {
    assert.equal(ownPrsFrom(gh([listed(1, { title: " \n " })]), "/r")?.[url(1)]?.title, "feat");
    assert.equal(ownPrsFrom(gh([listed(1, { title: 5 })]), "/r")?.[url(1)]?.title, "feat");
  });

  it("is undefined when gh's output cannot be read", () => {
    assert.equal(ownPrsFrom("not json", "/r"), undefined);
    assert.equal(ownPrsFrom("{}", "/r"), undefined);
  });
});

describe("pickPr and forks", () => {
  it("never picks a fork's PR for a workspace's branch", () => {
    assert.equal(pickPr(gh([{ ...ghPr(1, "OPEN", "t"), isCrossRepository: true }]), "feat"), null);
  });
});

describe("cleanTitle", () => {
  it("turns control characters, C1 ones too, and runs of space into one space, trimmed", () => {
    assert.equal(cleanTitle("  Fix\tthe\n\nhook\u007f\u0085now "), "Fix the hook now");
  });

  it("cuts to the label length in whole characters, never half an emoji", () => {
    assert.equal(cleanTitle("x".repeat(500)).length, 120);
    // The emoji is two UTF-16 units, the length isLabel measures, so it
    // no longer fits after 119 characters and goes whole.
    assert.equal(cleanTitle("x".repeat(119) + "😀tail"), "x".repeat(119));
    assert.equal(cleanTitle("x".repeat(118) + "😀tail"), "x".repeat(118) + "😀");
  });

  it("always gives a title the saved state keeps", () => {
    const title = cleanTitle("😀".repeat(100));
    const kept = validateState({ prs: { w1: { ...pr(1), title } } }).prs.w1;
    assert.equal(kept?.title, title);
  });
});

describe("findOwnPrs", () => {
  const ws = (id: string, directory: string) => ({ id, directory });
  const repoByDir = (d: string) => (d.startsWith("/a") ? "/a/.git" : "/b/.git");
  const b = (n: number) => own(n, { repo: "/b/.git" });

  it("asks git once per directory and gh once per repo", () => {
    const gitAsked: string[] = [];
    const ghAsked: string[] = [];
    const look: OwnLookups = {
      repoOf: (d) => {
        gitAsked.push(d);
        return repoByDir(d);
      },
      ownPrs: (d, repo) => {
        ghAsked.push(d);
        return repo === "/a/.git" ? { [url(1)]: own(1) } : { [url(2)]: b(2) };
      },
    };
    const found = findOwnPrs(
      [ws("1", "/a"), ws("2", "/a"), ws("3", "/a-wt"), ws("4", "/b")],
      { [url(9)]: own(9) },
      look,
    );
    assert.deepEqual(found, { [url(1)]: own(1), [url(2)]: b(2) });
    assert.deepEqual(gitAsked, ["/a", "/a-wt", "/b"]);
    assert.deepEqual(ghAsked, ["/a", "/b"]);
  });

  it("drops everything when no workspace sits in a repo", () => {
    const look: OwnLookups = { repoOf: () => null, ownPrs: () => ({ [url(1)]: own(1) }) };
    assert.deepEqual(findOwnPrs([ws("1", "/x")], { [url(9)]: own(9) }, look), {});
  });

  it("keeps a failed repo's previous entries, and only that repo's", () => {
    const previous = { [url(1)]: own(1), [url(8)]: b(8), [url(9)]: own(9) };
    const look: OwnLookups = {
      repoOf: repoByDir,
      ownPrs: (_d, repo) => (repo === "/a/.git" ? { [url(1)]: own(1, { title: "New" }) } : undefined),
    };
    assert.deepEqual(findOwnPrs([ws("1", "/a"), ws("2", "/b")], previous, look), {
      [url(8)]: b(8),
      [url(1)]: own(1, { title: "New" }),
    });
  });

  it("drops a repo no workspace sits in any more, even when another repo failed", () => {
    const previous = { [url(8)]: b(8) };
    const look: OwnLookups = { repoOf: () => "/a/.git", ownPrs: () => undefined };
    assert.deepEqual(findOwnPrs([ws("1", "/a")], previous, look), {});
  });

  it("keeps entries from repos not freshly asked when git could not name a directory's repo", () => {
    const previous = { [url(1)]: own(1), [url(8)]: b(8) };
    const look: OwnLookups = {
      repoOf: (d) => (d === "/a" ? "/a/.git" : undefined),
      ownPrs: () => ({}),
    };
    assert.deepEqual(findOwnPrs([ws("1", "/a"), ws("2", "/b")], previous, look), { [url(8)]: b(8) });
  });
});

describe("the ownPrs map in state.json", () => {
  it("keeps a valid entry keyed by its url, and drops bad keys, titles, repos and statuses", () => {
    const raw = {
      ownPrs: {
        [url(1)]: { ...own(1), checks: [{ name: "ci", state: "pass" }], mergeable: true },
        notAUrl: own(2),
        [url(3)]: own(3, { title: "" }),
        [url(4)]: own(4, { title: "a\nb" }),
        [url(5)]: { ...own(5), status: "merged" },
        [url(6)]: pr(6),
        [url(7)]: own(7, { repo: "relative" }),
      },
    };
    assert.deepEqual(validateState(raw).ownPrs, { [url(1)]: own(1) });
  });

  it("cannot be set by a URL", () => {
    const set = applySet(emptyState(), "ownPrs." + url(1), JSON.stringify(own(1)));
    assert.equal(set.ok, false);
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

describe("writePollState", () => {
  const dir = mkdtempSync(join(tmpdir(), "pr-poll-state-"));
  after(() => rmSync(dir, { recursive: true, force: true }));

  it("prunes subagent runs on every write, not only when a hook fires", () => {
    const path = join(dir, "state.json");
    // A stale, unpaired run, seeded directly rather than through the hook.
    writeSubagents(path, () => ({ w1: [{ id: "toolu_1", session: "s1", label: "Old", startedEpoch: 0 }] }));
    const result = writePollState(path, {}, {}, 20 * 60);
    assert.deepEqual(result, { ok: true, changed: true });
    const written = JSON.parse(readFileSync(path, "utf8"));
    assert.deepEqual(written.subagents, {});
  });

  it("says unchanged when there is nothing to prune and the prs are the same", () => {
    const path = join(dir, "state-stable.json");
    writePollState(path, { a: pr(1) }, {}, 100);
    assert.deepEqual(writePollState(path, { a: pr(1) }, {}, 100), { ok: true, changed: false });
  });

  it("saves the poll status it is given alongside the maps", () => {
    const path = join(dir, "state-poll.json");
    writePollState(path, { a: pr(1) }, {}, 100, { okEpoch: 100 });
    assert.deepEqual(writePollState(path, { a: pr(1) }, {}, 100, { okEpoch: 100 }), { ok: true, changed: false });
    assert.deepEqual(writePollState(path, { a: pr(1) }, {}, 100, { okEpoch: 100, error: "unavailable" }), {
      ok: true,
      changed: true,
    });
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")).poll, { okEpoch: 100, error: "unavailable" });
  });

  it("is a change when only the subagent prune drops something, even with the same prs", () => {
    const path = join(dir, "state-prune-only.json");
    writeSubagents(path, () => ({ w1: [{ id: "toolu_1", session: "s1", label: "Old", startedEpoch: 0 }] }));
    writePollState(path, { a: pr(1) }, {}, 100);
    assert.deepEqual(writePollState(path, { a: pr(1) }, {}, 100 + 20 * 60), { ok: true, changed: true });
  });
});

describe("ghOutcome", () => {
  const r = (status: number | null, stderr = "", missing = false) => ({ status, stderr, missing });

  it("is ok when gh answered", () => {
    assert.equal(ghOutcome(r(0)), "ok");
  });

  it("is missing when the gh binary is not there, whatever else it says", () => {
    assert.equal(ghOutcome(r(null, "", true)), "missing");
  });

  it("is signed-out when gh asks for a login", () => {
    assert.equal(ghOutcome(r(4, "To get started with GitHub CLI, please run:  gh auth login")), "signed-out");
    assert.equal(ghOutcome(r(1, "You are not logged into any GitHub hosts.")), "signed-out");
  });

  it("is skip when the directory is not a GitHub repo, since that says nothing about gh", () => {
    assert.equal(ghOutcome(r(1, "failed to run git: fatal: not a git repository")), "skip");
    assert.equal(ghOutcome(r(1, "no git remotes found")), "skip");
    assert.equal(
      ghOutcome(r(1, "none of the git remotes configured for this repository point to a known GitHub host")),
      "skip",
    );
  });

  it("is unavailable for anything else, a timeout included", () => {
    assert.equal(ghOutcome(r(1, "error connecting to api.github.com")), "unavailable");
    assert.equal(ghOutcome(r(null)), "unavailable");
  });
});

describe("nextPoll", () => {
  it("stamps the first success", () => {
    assert.deepEqual(nextPoll(undefined, { answered: 2 }, 1000), { okEpoch: 1000 });
  });

  it("keeps a success under five minutes old, so a quiet run is no write", () => {
    assert.deepEqual(nextPoll({ okEpoch: 1000 }, { answered: 1 }, 1000 + 299), { okEpoch: 1000 });
  });

  it("refreshes a success once it is five minutes old", () => {
    assert.deepEqual(nextPoll({ okEpoch: 1000 }, { answered: 1 }, 1000 + 300), { okEpoch: 1300 });
  });

  it("records why when every gh call failed, keeping the last success", () => {
    assert.deepEqual(nextPoll({ okEpoch: 1000 }, { answered: 0, error: "signed-out" }, 9000), {
      okEpoch: 1000,
      error: "signed-out",
    });
  });

  it("records an error with no last success to keep", () => {
    assert.deepEqual(nextPoll(undefined, { answered: 0, error: "missing" }, 9000), { error: "missing" });
  });

  it("clears the error and stamps once a call answers again", () => {
    assert.deepEqual(nextPoll({ okEpoch: 1000, error: "unavailable" }, { answered: 1 }, 1100), { okEpoch: 1000 });
    assert.deepEqual(nextPoll({ okEpoch: 1000, error: "unavailable" }, { answered: 1 }, 9000), { okEpoch: 9000 });
  });

  it("is a success when some calls answered and others failed", () => {
    assert.deepEqual(nextPoll(undefined, { answered: 1, error: "unavailable" }, 1000), { okEpoch: 1000 });
  });

  it("is a success when the run needed no gh call at all", () => {
    assert.deepEqual(nextPoll({ okEpoch: 1000 }, { answered: 0 }, 9000), { okEpoch: 9000 });
  });
});

describe("delayFrom", () => {
  it("reads --delay in either form, in seconds", () => {
    assert.equal(delayFrom(["--delay", "10"]), 10_000);
    assert.equal(delayFrom(["--delay=10"]), 10_000);
    assert.equal(delayFrom(["--delay", "60"]), 60_000);
  });

  it("is no delay without the flag", () => {
    assert.equal(delayFrom([]), 0);
    assert.equal(delayFrom(["10"]), 0);
  });

  it("is no delay for a missing, malformed or out of range value", () => {
    assert.equal(delayFrom(["--delay"]), 0);
    assert.equal(delayFrom(["--delay", "--x"]), 0);
    assert.equal(delayFrom(["--delay", "1.5"]), 0);
    assert.equal(delayFrom(["--delay=-5"]), 0);
    assert.equal(delayFrom(["--delay", "0"]), 0);
    assert.equal(delayFrom(["--delay", "61"]), 0);
  });
});

describe("lockWithin", () => {
  // An acquire that fails `busy` times, then succeeds, counting tries.
  const lock = (busy: number) => {
    const seen = { tries: 0, waits: 0 };
    return {
      seen,
      acquire: () => ++seen.tries > busy,
      wait: async () => {
        seen.waits++;
      },
    };
  };

  it("takes a free lock on the first try, without waiting", async () => {
    const l = lock(0);
    assert.equal(await lockWithin(l.acquire, 5, l.wait), true);
    assert.deepEqual(l.seen, { tries: 1, waits: 0 });
  });

  it("with no retries, as an undelayed run, tries once and gives up", async () => {
    const l = lock(1);
    assert.equal(await lockWithin(l.acquire, 0, l.wait), false);
    assert.deepEqual(l.seen, { tries: 1, waits: 0 });
  });

  it("waits between tries until the lock frees", async () => {
    const l = lock(3);
    assert.equal(await lockWithin(l.acquire, 5, l.wait), true);
    assert.deepEqual(l.seen, { tries: 4, waits: 3 });
  });

  it("gives up once the retries run out", async () => {
    const l = lock(10);
    assert.equal(await lockWithin(l.acquire, 2, l.wait), false);
    assert.deepEqual(l.seen, { tries: 3, waits: 2 });
  });
});
