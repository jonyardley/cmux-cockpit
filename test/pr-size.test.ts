// The pull request size check: count added lines from numstat, and pass
// over the limit only with a filled "## Size" section.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { added, diffRange, EXCLUDE, LIMIT, sizeMessage } from "../scripts/pr-size.ts";

describe("added", () => {
  it("sums the first column and skips binary files", () => {
    assert.equal(added("3\t1\ta.ts\n-\t-\tlogo.png\n10\t0\tb.ts\n"), 13);
  });
});

describe("sizeMessage", () => {
  it("passes at the limit without reading the body", () => {
    assert.equal(
      sizeMessage(LIMIT, () => assert.fail("read the body")),
      null,
    );
  });

  it("fails over the limit with no Size section", () => {
    assert.match(sizeMessage(LIMIT + 1, () => "## Review\n\nDone.\n") ?? "", new RegExp(`over ${LIMIT}`));
  });

  it("fails over the limit when Size holds a placeholder", () => {
    assert.notEqual(
      sizeMessage(LIMIT + 1, () => "## Size\n\nTBD\n"),
      null,
    );
  });

  it("passes over the limit when Size says why", () => {
    assert.equal(
      sizeMessage(LIMIT + 1, () => "## Size\n\nOne generated table.\n"),
      null,
    );
  });
});

describe("sizeMessage when the description cannot be read", () => {
  it("reports the read error rather than a missing section", () => {
    const m = sizeMessage(LIMIT + 1, () => new Error("gh: not logged in")) ?? "";
    assert.match(m, /could not be read/);
    assert.match(m, /gh: not logged in/);
  });
});

describe("diffRange", () => {
  it("uses the merge commit's first parent in CI", () => {
    assert.deepEqual(diffRange(true, "ignored"), ["HEAD^1", "HEAD"]);
  });

  it("uses the merge base with origin/main by hand, or the base given", () => {
    assert.deepEqual(diffRange(false), ["--merge-base", "origin/main"]);
    assert.deepEqual(diffRange(false, "origin/stack"), ["--merge-base", "origin/stack"]);
  });
});

describe("EXCLUDE", () => {
  it("leaves the excluded paths out of a real git diff", () => {
    const dir = mkdtempSync(join(tmpdir(), "pr-size-"));
    // A git hook sets GIT_DIR and GIT_INDEX_FILE; left in, every command
    // here would act on the outer repository instead of the scratch one.
    const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_")));
    const git = (...args: string[]): string => {
      const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], {
        cwd: dir,
        encoding: "utf8",
        env: cleanEnv,
      });
      assert.equal(r.status, 0, r.stderr);
      return r.stdout;
    };
    try {
      git("init", "-q");
      git("commit", "-q", "--allow-empty", "-m", "base");
      const files = [
        "src/a.ts",
        "Cargo.lock",
        "web/package-lock.json",
        "test/fixtures/x.json",
        "test/__snapshots__/s.snap",
        "a/snapshots/s.txt",
        "test/golden/g.txt",
        "src/generated/g.ts",
      ];
      for (const f of files) {
        mkdirSync(join(dir, dirname(f)), { recursive: true });
        writeFileSync(join(dir, f), "1\n2\n");
      }
      git("add", "-A");
      git("commit", "-q", "-m", "change");
      assert.equal(added(git("diff", "--numstat", "HEAD^1", "HEAD", "--", ".", ...EXCLUDE)), 2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
