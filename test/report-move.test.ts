// The pure parts of the move hook: finding the "Your move" line at the end
// of a reply, counting the decisions it lays out and the options it leans
// to, and the saved entry's shape in the state file. The file write, the
// rebuild and the stdin/env plumbing are not covered.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { decisionsIn, lastReply, moveFrom, moveLine } from "../scripts/hooks/report-move.ts";
import { applySet, emptyState, MAX_MOVE, urlMaySet } from "../scripts/state-config.ts";

const DECISIONS = [
  "Jon, two calls.",
  "",
  "**1. Where the card gets the line**",
  "",
  "> a) A Stop hook saves it. **Lean.**",
  ">",
  "> b) Quote the first 240 characters.",
  "",
  "**2. Where the chip sits**",
  "",
  "> a) Before the branch.",
  ">",
  "> b) After the PR. (lean)",
  "",
  "---",
  "",
  'Your move: reply "1a 2b" (under a minute, yours).',
].join("\n");

describe("moveLine", () => {
  it("takes the text after the last Your move label", () => {
    assert.equal(
      moveLine("Done.\n\nYour move: the work is finished. Run /clear now."),
      "the work is finished. Run /clear now.",
    );
    assert.equal(moveLine("Your move: old\n\nYour move: new"), "new");
  });

  it("reads through bold, a quote, a list marker, code ticks and link targets", () => {
    assert.equal(moveLine("**Your move:** run `npm run check`"), "run npm run check");
    assert.equal(moveLine("> Your move: read [the page](https://claude.ai/artifact/x)"), "read the page");
    assert.equal(moveLine("- your move: go"), "go");
  });

  it("is null without the label, and cuts a long line with an ellipsis", () => {
    assert.equal(moveLine("Nothing to do here."), null);
    assert.equal(moveLine("I made my move: done"), null);
    const long = moveLine("Your move: " + "word ".repeat(80));
    assert.ok(long && long.length === MAX_MOVE && long.endsWith("…"));
  });
});

describe("decisionsIn", () => {
  it("counts the bold numbered headings and the lean under each", () => {
    assert.deepEqual(decisionsIn(DECISIONS), { count: 2, leans: "1a 2b" });
  });

  it("keeps the first lean per decision and ignores options before any heading", () => {
    const text = "a) stray (lean)\n**1. One**\na) x Lean\nb) y lean too";
    assert.deepEqual(decisionsIn(text), { count: 1, leans: "1a" });
  });

  it("is empty for a reply with no decisions", () => {
    assert.deepEqual(decisionsIn("Just prose.\n1. a plain list\n2. another"), { count: 0, leans: "" });
  });
});

describe("moveFrom", () => {
  it("saves the line, when, the session and any decisions", () => {
    assert.deepEqual(moveFrom(DECISIONS, 1000, "s1"), {
      text: 'reply "1a 2b" (under a minute, yours).',
      epoch: 1000,
      session: "s1",
      decisions: 2,
      leans: "1a 2b",
    });
    assert.deepEqual(moveFrom("Your move: go", 5), { text: "go", epoch: 5 });
  });

  it("is null when the reply has no move line", () => {
    assert.equal(moveFrom(DECISIONS.replace("Your move:", "Next:"), 1000), null);
  });
});

describe("lastReply", () => {
  const line = (type: string, text: string, extra: Record<string, unknown> = {}) =>
    JSON.stringify({
      type,
      uuid: "u-" + text.length,
      timestamp: "2026-09-28T22:00:00Z",
      message: { content: [{ type: "text", text }] },
      ...extra,
    });

  it("is the last main-chat reply's text, skipping a helper's and a prompt", () => {
    const lines = [
      line("assistant", "first"),
      line("assistant", "second"),
      line("assistant", "helper", { isSidechain: true }),
      line("user", "prompt"),
    ];
    assert.equal(lastReply(lines), "second");
  });

  it("is empty with no reply", () => {
    assert.equal(lastReply(["", "not json"]), "");
  });
});

describe("the moves map", () => {
  const set = (value: unknown) => applySet(emptyState(), "moves.ws1", JSON.stringify(value));

  it("keeps a well-formed move and drops a bad optional field's entry", () => {
    const ok = set({ text: "go", epoch: 10, session: "s1", decisions: 2, leans: "1a 2b" });
    assert.ok(ok.ok);
    assert.deepEqual(ok.ok && ok.state.moves.ws1, {
      text: "go",
      epoch: 10,
      session: "s1",
      decisions: 2,
      leans: "1a 2b",
    });
    assert.equal(set({ text: "go", epoch: 10, decisions: 0 }).ok, false);
    assert.equal(set({ text: "go", epoch: 10, leans: "one b" }).ok, false);
    assert.equal(set({ text: " padded ", epoch: 10 }).ok, false);
    assert.equal(set({ text: "x".repeat(MAX_MOVE + 1), epoch: 10 }).ok, false);
  });

  it("clears on null, drops moves a day older than the new one, and refuses a URL", () => {
    const first = applySet(emptyState(), "moves.old", JSON.stringify({ text: "old", epoch: 0 }));
    assert.ok(first.ok);
    const next = first.ok ? applySet(first.state, "moves.new", JSON.stringify({ text: "new", epoch: 90_000 })) : first;
    assert.deepEqual(next.ok && Object.keys(next.state.moves), ["new"]);
    const cleared = next.ok ? applySet(next.state, "moves.new", null) : next;
    assert.deepEqual(cleared.ok && cleared.state.moves, {});
    assert.equal(urlMaySet("moves.ws1"), false);
  });
});
