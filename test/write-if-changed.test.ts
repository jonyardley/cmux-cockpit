import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { writeIfChanged } from "../scripts/write-if-changed.ts";

const dir = mkdtempSync(join(tmpdir(), "write-if-changed-"));
after(() => rmSync(dir, { recursive: true, force: true }));
const bytes = (s: string) => new TextEncoder().encode(s);

describe("writeIfChanged", () => {
  it("writes a new file, making its folder", () => {
    const path = join(dir, "new", "a.js");
    assert.equal(writeIfChanged(path, bytes("one")), true);
    assert.equal(readFileSync(path, "utf8"), "one");
  });

  it("leaves a file with the same bytes untouched, so cmux does not reload it", () => {
    const path = join(dir, "same.js");
    writeIfChanged(path, bytes("same"));
    utimesSync(path, 1000, 1000);
    assert.equal(writeIfChanged(path, bytes("same")), false);
    assert.equal(statSync(path).mtimeMs, 1000 * 1000);
  });

  it("rewrites a file whose bytes differ", () => {
    const path = join(dir, "differs.js");
    writeIfChanged(path, bytes("before"));
    assert.equal(writeIfChanged(path, bytes("after")), true);
    assert.equal(readFileSync(path, "utf8"), "after");
  });
});
