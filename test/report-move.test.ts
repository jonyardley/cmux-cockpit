// The pure parts of the move hook: finding the "Your move" line at the end
// of a reply, counting the decisions it lays out and the options it leans
// to, and the saved entry's shape in the state file. The file write, the
// rebuild and the stdin/env plumbing are not covered.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { decisionsIn, lastReply, moveFrom, moveLine, shouldSendBack } from "../scripts/hooks/report-move.ts";
import { applySet, cleanMove, emptyState, MAX_MOVE, MOVE_MAX_AGE_S, urlMaySet } from "../scripts/state-config.ts";

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

  it("takes one word of drift before the colon, inside the bold or after it", () => {
    assert.equal(moveLine("Nothing for you yet: CI is running on #2183."), "CI is running on #2183.");
    assert.equal(moveLine("**Nothing for you right now:** the gate is running"), "the gate is running");
    assert.equal(moveLine("**Nothing for you** yet: CI is running"), "CI is running");
    assert.equal(moveLine("**Your move** now: go"), "go");
    assert.equal(moveLine("Your move for now: go"), "go");
  });

  it("keeps a sentence that only starts like a label as prose", () => {
    assert.equal(moveLine("Your move to main was blocked: the guard fired."), null);
    assert.equal(moveLine("Nothing for you to do until CI lands: it is queued"), null);
    assert.equal(moveLine("Your move #2: go"), null);
  });

  it("is null without the label, and cuts a long line with an ellipsis", () => {
    assert.equal(moveLine("Nothing to do here."), null);
    assert.equal(moveLine("I made my move: done"), null);
    const long = moveLine("Your move: " + "word ".repeat(80));
    assert.ok(long && long.length === MAX_MOVE && long.endsWith("…"));
  });

  it("skips a Your move line inside a code fence", () => {
    const text = [
      "Your move: paste the opener below into a new session.",
      "",
      "```",
      "Fix the card. Your move: none",
      "Your move: this is the other session's",
      "```",
    ].join("\n");
    assert.equal(moveLine(text), "paste the opener below into a new session.");
    assert.equal(moveLine("```\nYour move: go\n```"), null);
  });
});

describe("cleanMove", () => {
  it("keeps a line that fits as it is, and a line one over gets the ellipsis", () => {
    assert.equal(cleanMove("x".repeat(MAX_MOVE)), "x".repeat(MAX_MOVE));
    assert.equal(cleanMove("x".repeat(MAX_MOVE + 1)), `${"x".repeat(MAX_MOVE - 1)}…`);
  });

  it("drops the space before the ellipsis, and is null for nothing usable", () => {
    assert.equal(cleanMove(`${"x".repeat(MAX_MOVE - 2)} tail`), `${"x".repeat(MAX_MOVE - 2)}…`);
    assert.equal(cleanMove("  \n "), null);
    assert.equal(cleanMove(5), null);
  });

  it("cuts by UTF-16 length, so an emoji line still ends in an ellipsis and fits", () => {
    const out = cleanMove("😀".repeat(400)) ?? "";
    assert.ok(out.length <= MAX_MOVE, String(out.length));
    assert.ok(out.endsWith("…"));
    assert.ok(!/[\ud800-\udbff]…$/.test(out), "no half emoji before the ellipsis");
  });
});

describe("decisionsIn", () => {
  it("counts the bold numbered headings and the lean under each", () => {
    assert.deepEqual(decisionsIn(DECISIONS), { count: 2, leans: "1a 2b" });
  });

  it("keeps the first lean per decision and ignores options before any heading", () => {
    const text = "a) stray (lean)\n**1. One**\na) x **Lean.**\nb) y (lean) too";
    assert.deepEqual(decisionsIn(text), { count: 1, leans: "1a" });
  });

  it("reads a bold option letter and each lean marker", () => {
    const text = [
      "**1. One**",
      "> **a)** x",
      "> **b)** y **Lean**",
      "**2. Two**",
      "> a) x (recommended)",
      "**3. Three**",
      "> a) x",
      "> b) y **Recommended**",
    ].join("\n");
    assert.deepEqual(decisionsIn(text), { count: 3, leans: "1b 2a 3b" });
  });

  it("takes the word lean in prose as no lean", () => {
    const text = "**1. One**\n> a) keep the card lean\n> b) a leaner card, recommended by nobody";
    assert.deepEqual(decisionsIn(text), { count: 1, leans: "" });
  });

  it("counts a heading only when an option follows it before the next", () => {
    const text = "**1. Just a bold numbered point**\nProse.\n**2. Real**\n> a) x\n> b) y";
    assert.deepEqual(decisionsIn(text), { count: 1, leans: "" });
  });

  it("ends a decision's options at a rule or a heading", () => {
    const rule = "**1. One**\n> a) x\n\n---\n\na) a list after the rule (lean)";
    assert.deepEqual(decisionsIn(rule), { count: 1, leans: "" });
    const heading = "**1. One**\n> a) x\n## Notes\nb) not an option (lean)";
    assert.deepEqual(decisionsIn(heading), { count: 1, leans: "" });
  });

  it("reads the bulleted layout: situation bullet, nested options, a rule between decisions", () => {
    const text = [
      "**1. Where the card gets the line**",
      "",
      "- The card shows the first 240 characters, so the move line is cut off.",
      "",
      "    - **a.** Read the transcript on every frame, which is slow.",
      "",
      "    - **b. Recommended.** Save the line from the Stop hook.",
      "",
      "---",
      "",
      "- **2. How long it shows**",
      "",
      "- Jon may never look, so a saved line can go stale.",
      "",
      "    - **a. Lean.** Until the next prompt.",
      "",
      "    - **b.** For a fixed hour.",
      "",
      "---",
      "",
      "Your move: 1b 2a.",
    ].join("\n");
    assert.deepEqual(decisionsIn(text), { count: 2, leans: "1b 2a" });
  });

  it("does not take a bulleted situation for an option", () => {
    const text =
      "**1. One**\n- I think the card is lean enough.\n- e.g. this one\n- a) the card is cut **Recommended**";
    assert.deepEqual(decisionsIn(text), { count: 0, leans: "" });
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

  it("saves a Nothing for you line as idle, and a later Your move line wins", () => {
    assert.deepEqual(moveFrom("Done.\n\n**Nothing for you:** CI is running on #2171.", 5), {
      text: "CI is running on #2171.",
      epoch: 5,
      idle: true,
    });
    assert.deepEqual(moveFrom("Nothing for you: CI runs.\n\nYour move: go", 5), { text: "go", epoch: 5 });
    assert.equal(moveLine("I have nothing for you: fine"), null, "only as the line's label");
    assert.equal(moveFrom("Nothing for you yet: CI runs.", 5)?.idle, true, "a drifted label is still idle");
  });

  it("is null when the reply has no move line", () => {
    assert.equal(moveFrom(DECISIONS.replace("Your move:", "Next:"), 1000), null);
  });
});

describe("shouldSendBack", () => {
  const stop = { hook_event_name: "Stop" };

  it("sends back an interactive reply with no closing line", () => {
    assert.equal(shouldSendBack(stop, "CI is running; I'll report when it lands.", true), true);
    assert.equal(
      shouldSendBack(stop, "Opener:\n\n```\nYour move: go\n```", true),
      true,
      "a fenced label is not the reply's",
    );
  });

  it("lets a reply with either label end, drifted wording included", () => {
    for (const reply of ["Done.\n\nYour move: go", "Nothing for you: CI runs.", "Nothing for you yet: CI runs."])
      assert.equal(shouldSendBack(stop, reply, true), false, reply);
  });

  it("leaves a reply with decisions alone, since a one-line retry would lose them", () => {
    assert.equal(shouldSendBack(stop, DECISIONS.replace("Your move:", "Next:"), true), false);
  });

  it("never sends back twice, a headless run, or a turn with no reply to judge", () => {
    assert.equal(shouldSendBack({ ...stop, stop_hook_active: true }, "Done.", true), false);
    assert.equal(shouldSendBack(stop, "Done.", false), false);
    assert.equal(shouldSendBack(stop, "  \n", true), false);
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

  const toolResult = JSON.stringify({
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] },
  });

  it("is the reply that ends the lines, skipping a helper's and a meta line", () => {
    const lines = [
      line("user", "prompt"),
      line("assistant", "first"),
      line("assistant", "second"),
      line("assistant", "helper", { isSidechain: true }),
      line("user", "helper's prompt", { isSidechain: true }),
      line("user", "caveat", { isMeta: true }),
    ];
    assert.equal(lastReply(lines), "second");
  });

  it("never returns a reply from before the latest prompt: that one is not flushed yet", () => {
    const lines = [line("assistant", "Your move: an old turn's"), line("user", "prompt")];
    assert.equal(lastReply(lines), "");
    const plain = [line("assistant", "old"), JSON.stringify({ type: "user", message: { content: "prompt" } })];
    assert.equal(lastReply(plain), "");
  });

  it("reads past a tool result to the final reply, but not a reply that a tool result follows", () => {
    assert.equal(lastReply([line("user", "prompt"), toolResult, line("assistant", "final")]), "final");
    assert.equal(lastReply([line("user", "prompt"), line("assistant", "Let me look."), toolResult]), "");
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

  it("clears on null, drops moves a week older than the new one, and refuses a URL", () => {
    const first = applySet(emptyState(), "moves.old", JSON.stringify({ text: "old", epoch: 0 }));
    assert.ok(first.ok);
    const days = first.ok ? applySet(first.state, "moves.new", JSON.stringify({ text: "new", epoch: 90_000 })) : first;
    assert.deepEqual(days.ok && Object.keys(days.state.moves), ["old", "new"], "a chat waits more than a day");
    const epoch = MOVE_MAX_AGE_S + 1;
    const next = first.ok ? applySet(first.state, "moves.new", JSON.stringify({ text: "new", epoch })) : first;
    assert.deepEqual(next.ok && Object.keys(next.state.moves), ["new"]);
    const cleared = next.ok ? applySet(next.state, "moves.new", null) : next;
    assert.deepEqual(cleared.ok && cleared.state.moves, {});
    assert.equal(urlMaySet("moves.ws1"), false);
  });
});
