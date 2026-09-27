// The PR poller (#7): reading cmux's and gh's output, choosing a branch's PR,
// building the saved map, and the `prs` map's contract in the state file.
// The cmux, git and gh subprocesses themselves are not covered.

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { findPrs, type Lookups, parseWindowIds, parseWorkspaces, pickPr } from "../scripts/pr-poll.ts";
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

  it("returns undefined when gh's output cannot be read", () => {
    assert.equal(pickPr("oops", "feat"), undefined);
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
});
