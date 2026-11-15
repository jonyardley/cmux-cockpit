// The pull request size check: count added lines from numstat, and pass
// over the limit only with a filled "## Size" section.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { added, LIMIT, sizeMessage } from "../scripts/pr-size.ts";

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
    assert.match(sizeMessage(LIMIT + 1, () => "## Review\n\nDone.\n") ?? "", /over 800/);
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
