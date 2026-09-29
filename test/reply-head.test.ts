// The reply head that ties a saved move to the reply it came from: the same
// for the hook's full reply and for cmux's cut latestMessage, with or
// without the markdown.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { HEAD_CHARS, isReplyOf, replyHead } from "../src/shared/reply-head.ts";

describe("replyHead", () => {
  it("keeps only lower-case letters and digits, up to HEAD_CHARS", () => {
    assert.equal(replyHead("**Jon**, PR #120 is merged."), "jonpr120ismerged");
    assert.equal(replyHead("word ".repeat(20)).length, HEAD_CHARS);
    assert.equal(replyHead("Jon, écrit ça."), "jonécritça", "letters beyond ASCII count");
  });

  it("reads a link as its words, so a stripped message gives the same head", () => {
    assert.equal(replyHead("See [the page](https://claude.ai/x) now"), replyHead("See the page now"));
  });

  it("drops markup and is empty when nothing readable is left", () => {
    assert.equal(replyHead("<system-reminder>x</system-reminder> Done here"), "donehere");
    assert.equal(replyHead("<a>b</a>"), "");
    assert.equal(replyHead(undefined), "");
    assert.equal(replyHead(null), "");
  });

  it("reads only what cmux keeps of a message", () => {
    assert.equal(replyHead(" ".repeat(240) + "Late words"), "");
  });
});

describe("isReplyOf", () => {
  it("matches a message whose head starts with the saved one", () => {
    assert.ok(isReplyOf("Jon, PR #120 is merged.", "jonpr120"));
    assert.ok(isReplyOf("Jon, PR #120 is merged.", "jonpr120ismerged"));
    assert.ok(!isReplyOf("Jon, PR #121 is merged.", "jonpr120ismerged"));
    assert.ok(!isReplyOf(undefined, "jon"));
  });

  it("never matches an empty head", () => {
    assert.ok(!isReplyOf("anything", ""));
  });
});
