// The PR description check: both required sections must hold real text,
// not only the template's placeholder comment, the attribution footer, or a
// stand-in such as "Pending.".

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { bodyMessage, check, missingSections } from "../scripts/pr-body.ts";

const FOOTER = "🤖 Generated with [Claude Code](https://claude.com/claude-code)";

const filled = `## What changed

A thing.

## Look at after reload

Nothing on screen.

## Review

/code-review high: two findings, both fixed.

${FOOTER}
`;

describe("missingSections", () => {
  it("passes a body with both sections filled", () => {
    assert.deepEqual(missingSections(filled), []);
  });

  it("flags a section left as the template comment", () => {
    const body = filled.replace("Nothing on screen.", "<!-- Required. Say what to check. -->");
    assert.deepEqual(missingSections(body), ["Look at after reload"]);
  });

  it("does not count the attribution footer as the last section's text", () => {
    const body = filled.replace("/code-review high: two findings, both fixed.", "<!-- pending -->");
    assert.deepEqual(missingSections(body), ["Review"]);
  });

  it("flags a missing heading and an empty last section", () => {
    const body = "## What changed\n\nA thing.\n\n## Review\n\n";
    assert.deepEqual(missingSections(body), ["Look at after reload", "Review"]);
  });

  it("flags a section whose whole text is a placeholder", () => {
    const standIns = [
      "Pending.",
      "pending",
      "TBD",
      "todo!",
      "WIP...",
      "To do",
      "Review pending.",
      "Not yet.",
      "**Pending.**",
      "_TBD_.",
      "  pending \u2026",
      "<!-- Required. -->\nPending.",
      "- Pending.",
      "> TBD",
      "1. TODO",
      "(pending)",
      "[TBD]",
      "~~WIP~~",
      "to-do",
      "T.B.D.",
      "TBC",
      "Pending review.",
      "### Findings\nPending.",
      "Pending.\n\nTBD",
    ];
    for (const text of standIns) {
      const body = filled.replace("/code-review high: two findings, both fixed.", text);
      assert.deepEqual(missingSections(body), ["Review"], JSON.stringify(text));
    }
    const both = filled
      .replace("Nothing on screen.", "TBD")
      .replace("/code-review high: two findings, both fixed.", "wip");
    assert.deepEqual(missingSections(both), ["Look at after reload", "Review"]);
  });

  it("passes real text that only mentions a placeholder word", () => {
    const real = [
      "No findings; nothing pending.",
      "Pending: one finding, answered below.",
      "TBD in a follow-up: the colour token, tracked in #30.",
      "/code-review high: one finding, a stale todo comment, fixed.",
      "Not yet reloaded, but nothing on screen changes.",
      "Pending.\nThen reviewed: no findings.",
      "pendingly",
      "TODO: fill in after review, but one finding is already fixed.",
      "### Findings\nNone.",
      "- Pending\n- /code-review high: no findings",
    ];
    for (const text of real) {
      const body = filled.replace("/code-review high: two findings, both fixed.", text);
      assert.deepEqual(missingSections(body), [], JSON.stringify(text));
    }
  });

  it("does not take a longer heading for the required one", () => {
    const body = filled.replace("## Review", "## Review notes");
    assert.deepEqual(missingSections(body), ["Review"]);
  });

  it("ignores headings inside a code fence", () => {
    const body = filled.replace(
      "/code-review high: two findings, both fixed.",
      "```\n## pasted output\n```\nBoth fixed.",
    );
    assert.deepEqual(missingSections(body), []);
    const onlyFence = filled.replace("/code-review high: two findings, both fixed.", "```\n## x\n```");
    assert.deepEqual(missingSections(onlyFence), [], "a fenced block is still content");
  });
});

describe("check", () => {
  it("passes a filled pull_request event", () => {
    assert.equal(check({ pull_request: { body: filled } }), null);
  });

  it("fails, without throwing, on a null body, a null event or no pull_request", () => {
    for (const event of [{ pull_request: { body: null } }, null, {}, "x"]) {
      assert.match(check(event) ?? "", /"## Look at after reload" and "## Review" sections/);
    }
  });

  it("names a single missing section in the singular", () => {
    const body = filled.replace("Nothing on screen.", "");
    assert.equal(
      check({ pull_request: { body } }),
      `pr-body: fill in the PR description's "## Look at after reload" section.`,
    );
  });
});

describe("bodyMessage", () => {
  it("passes a filled body and names each missing section otherwise", () => {
    assert.equal(bodyMessage(filled), null);
    assert.equal(
      bodyMessage(filled.replace("/code-review high: two findings, both fixed.", "Pending.")),
      'pr-body: fill in the PR description\'s "## Review" section.',
    );
  });
});

describe("the workflow", () => {
  const yml = readFileSync(".github/workflows/pr-body.yml", "utf8");

  it("skips drafts, so a new PR is not red while its review is to come", () => {
    assert.match(yml, /!github\.event\.pull_request\.draft &&/);
  });

  it("runs when a PR leaves draft", () => {
    assert.match(yml, /types: \[[^\]]*\bready_for_review\b[^\]]*\]/);
  });
});
