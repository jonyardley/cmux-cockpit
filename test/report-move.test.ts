// The pure parts of the move hook: finding the "Your move" line at the end
// of a reply, counting the decisions it lays out and the options it leans
// to, and the saved entry's shape in the state file. The file write, the
// rebuild and the stdin/env plumbing are not covered.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { DescriptionRead } from "../scripts/hooks/description.ts";
import {
  type Delivery,
  decisionsIn,
  deliver,
  lastLine,
  lastReply,
  moveFrom,
  moveLine,
} from "../scripts/hooks/report-move.ts";
import {
  applySet,
  cleanMove,
  emptyState,
  isMoveDescription,
  MAX_MOVE,
  MOVE_MAX_AGE_S,
  moveDescription,
  moveOfDescription,
  type SavedMove,
  urlMaySet,
} from "../scripts/state-config.ts";

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

  it("takes only the exact label: drift, parentheticals and full stops are prose", () => {
    for (const reply of [
      "Nothing for you yet: CI is running on #2183.",
      "**Your move** now: go",
      "Your move (optional): go",
      "Nothing for you beyond that close-out: the review is running",
      "Both lanes are running. Nothing for you yet.",
      "Nothing for you right now. The agent is reading.",
      "Your move. Merge it.",
    ])
      assert.equal(moveLine(reply), null, reply);
    assert.equal(moveLine("**Nothing for you**: CI is running"), "CI is running", "colon outside the bold");
  });

  it("keeps a sentence that only starts like a label as prose", () => {
    assert.equal(moveLine("Your move to main was blocked: the guard fired."), null);
    assert.equal(moveLine("Nothing for you to do until CI lands: it is queued"), null);
    assert.equal(moveLine("Your move #2: go"), null);
  });

  it("reads a bare header from the first step below it", () => {
    const steps = "1. Run the script. Delta quits and reopens on its own:\n2. In Delta, open a new thread.";
    const want = "Run the script. Delta quits and reopens on its own:";
    assert.equal(moveLine(`Done.\n\nYour move:\n\n${steps}`), want);
    assert.equal(moveLine(`**Your move:**\n\n${steps}`), want);
    assert.equal(moveLine(`- Your move:\n\n${steps}`), want);
    assert.equal(moveLine("Your move:\n- **Paste** this\n- then that"), "Paste this");
    assert.equal(moveLine("Your move:\n\n1) Open it\n2) Close it"), "Open it");
  });

  it("is null for a bare header with nothing after it", () => {
    assert.equal(moveLine("Done.\n\nYour move:"), null);
    assert.equal(moveLine("Your move: old\n\nYour move:\n\n"), null);
  });

  it("takes no step from a rule, a heading or a decision under a bare header", () => {
    assert.equal(moveLine("Your move:\n\n---\n\nRun it."), null);
    assert.equal(moveLine("Your move:\n## Next\nstuff"), null);
    assert.equal(moveLine("Your move:\n\n**1. Where**\n\n    - **a. Recommended.** foo"), null);
  });

  it("skips a fenced block between a bare header and its steps", () => {
    const text = ["Your move:", "", "```", "npm run check", "```", "", "1. Paste it above.", "2. Then reload."].join(
      "\n",
    );
    assert.equal(moveLine(text), "Paste it above.");
    assert.equal(moveLine("Your move:\n\n```\nnpm run check\n```"), null);
  });

  it("takes a leading Jon, before the label", () => {
    assert.equal(
      moveLine("Jon, your move: say go and I'll check what already exists"),
      "say go and I'll check what already exists",
    );
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
  });

  it("saves a bare Nothing for you header as idle, with the first step", () => {
    assert.deepEqual(moveFrom("**Nothing for you:**\n\n1. CI is running on #9.", 5), {
      text: "CI is running on #9.",
      epoch: 5,
      idle: true,
    });
  });

  it("saves the last line, unlabelled, when the reply has no label, keeping its decisions", () => {
    assert.deepEqual(moveFrom(DECISIONS.replace("Your move:", "Next:"), 1000), {
      text: 'Next: reply "1a 2b" (under a minute, yours).',
      epoch: 1000,
      decisions: 2,
      leans: "1a 2b",
      unlabelled: true,
    });
    assert.deepEqual(moveFrom("Nothing for you yet: CI runs.", 5), {
      text: "Nothing for you yet: CI runs.",
      epoch: 5,
      unlabelled: true,
      noAsk: true,
    });
  });

  it("is null for a bare label with nothing under it, never quoting the label", () => {
    assert.equal(moveFrom("Done.\n\nYour move:", 5), null);
    assert.equal(moveFrom("Your move:\n\n---\n\nRun it.", 5), null);
    assert.equal(moveFrom("Done.\n\nNothing for you:", 5), null);
  });

  it("quotes no last line for a headless run, but keeps its labelled line", () => {
    assert.equal(moveFrom('{"ok": true}', 5, undefined, false), null);
    assert.deepEqual(moveFrom("Your move: go", 5, undefined, false), { text: "go", epoch: 5 });
  });

  it("is null for a reply with nothing to quote", () => {
    assert.equal(moveFrom("", 5), null);
    assert.equal(moveFrom("```\nnpm run check\n```", 5), null);
  });
});

// Jon's replies since 14 November 2026 carry no label: a quiet one says
// "Nothing needed from you." (#418). The reply that put a card in Needs
// you while its helper ran, word for word but for the project names, which stay out of tracked files.
const NOTHING_NEEDED_3012 = [
  "Jon, Notes app build: got it, I'll carry on. Your observation is noted for the retro.",
  "",
  "- The design rounds being slow is now on [the slow-build issue](https://github.com/example/notes/issues/3023), beside the slow core build, so the retro covers both.",
  "",
  "**Status**",
  "The screen takes about 20 minutes more. Then the two small core fixes go in, then review and screenshots for your word. Nothing needed from you.",
  "",
  "**Nothing to do until the screenshots arrive.**",
].join("\n");

// A reply ending on `last`, with a Status block above it.
const endingOn = (last: string): string => `Jon, Cockpit fix: on its way.\n\n**Status**\nThe build runs.\n${last}`;

describe("moveFrom, a reply that says nothing is needed", () => {
  it("saves the #3012 reply as idle, quoting its last line", () => {
    assert.deepEqual(moveFrom(NOTHING_NEEDED_3012, 5, "s1"), {
      text: "Nothing to do until the screenshots arrive.",
      epoch: 5,
      session: "s1",
      idle: true,
    });
  });

  it("reads each ending seen live as idle", () => {
    for (const last of [
      "Nothing needed from you.",
      "Nothing needed from you until the other app's pull request is ready.",
      "Nothing needed from you until the draft pull request is up.",
      "Nothing needed from you yet; the draft and that decision come in my next reply.",
    ]) {
      assert.deepEqual(moveFrom(endingOn(last), 5), { text: last, epoch: 5, idle: true }, last);
    }
  });

  it("reads a plain 'your' after the phrase as quiet", () => {
    for (const s of [
      "CI is running. Nothing needed from you until CI finishes on your pull request.",
      "Nothing needed from you while your other session finishes.",
    ]) {
      assert.deepEqual(moveFrom(endingOn(s), 5), { text: s, epoch: 5, idle: true }, s);
    }
  });

  it("reads an ask verb inside an 'until' or 'while' clause as quiet", () => {
    const status = (s: string): string =>
      `Jon, Cockpit quiet turns: the fix is on a branch.\n\n- **Hook** saves quiet replies as idle.\n\n**Status**\n${s}`;
    for (const last of [
      "**Nothing needed from you until the pull request is ready to merge.**",
      "**Nothing needed from you until the fix is ready to merge.**",
      "**Nothing needed from you until it's marked ready to merge.**",
      "**Nothing needed from you until the reviews are back.**",
    ]) {
      assert.equal(moveFrom(status(`Build runs.\n\n${last}`), 5)?.idle, true, last);
    }
    for (const s of [
      "Nothing needed from you while the reviewers run.",
      "Nothing needed from you until I open the draft.",
      "Nothing needed from you until the checks run.",
      "Nothing needed from you until I send the plan.",
    ]) {
      assert.equal(moveFrom(status(s), 5)?.idle, true, s);
    }
  });

  it("reads a plain last line of two quiet sentences as quiet", () => {
    for (const last of [
      "Nothing is running. Nothing needed from you.",
      "Nothing else is running. Nothing needed from you.",
    ]) {
      assert.deepEqual(moveFrom(endingOn(last), 5), { text: last, epoch: 5, idle: true }, last);
    }
  });

  it("reads the phrase through markdown and after a sentence's full stop", () => {
    assert.equal(moveFrom("Done.\n\n> **Nothing needed from you.**", 5)?.idle, true);
    assert.equal(moveFrom("- Jon, nothing needed from you.", 5)?.idle, true);
    assert.equal(moveFrom("CI runs! Nothing needed from you.\n\nBack soon.", 5)?.idle, true);
  });

  it("reads a bold closer with no ask verb as quiet once the reply says the phrase", () => {
    // Jon's live reply on 26 November, saved as waiting before the fix.
    const text = [
      "Jon, Cockpit review: option a is planned and building.",
      "",
      "**Status**",
      "One builder running, roughly 15 minutes. A draft pull request, already reviewed, will appear. Nothing needed from you.",
      "",
      "**No action yet; I'll report when the pull request lands.**",
    ].join("\n");
    assert.deepEqual(moveFrom(text, 5), {
      text: "No action yet; I'll report when the pull request lands.",
      epoch: 5,
      idle: true,
    });
    const ask = text.replace(
      "**No action yet; I'll report when the pull request lands.**",
      "**Say go and I'll push the fix.**",
    );
    waitsOnJon(ask);
    waitsOnJon(text.replace("lands.**", "lands; then merge it.**"));
  });

  it("lets a reply that lays out decisions wait on Jon", () => {
    const move = moveFrom(`${DECISIONS.replace("Your move:", "Next:")}\n\nNothing needed from you.`, 5);
    assert.equal(move?.unlabelled, true);
    assert.equal(move?.idle, undefined);
    assert.equal(move?.decisions, 2);
  });

  it("lets a bold last line that asks win", () => {
    for (const ask of [
      "**Say go and I'll push the fix. Nothing merges.**",
      "**Reply with the letter.**",
      "__Paste it into the main checkout.__",
    ]) {
      const text = `Jon, fix ready.\n\n**Status**\nNothing needed from you until then.\n\n${ask}`;
      assert.deepEqual(moveFrom(text, 5), { text: ask.replaceAll(/\*\*|__/g, ""), epoch: 5, unlabelled: true }, ask);
    }
  });

  it("lets a qualified sentence wait on Jon", () => {
    for (const s of [
      "Nothing needed from you except the merge.",
      "Nothing needed from you beyond a look at the picture.",
      "Nothing needed from you, but check the card after reload.",
      "Nothing needed from you besides the label.",
      "Nothing needed from you other than a yes.",
      "Nothing needed from you apart from the paste.",
      "Nothing needed from you aside from the reload.",
    ]) {
      assert.deepEqual(moveFrom(endingOn(s), 5), { text: s, epoch: 5, unlabelled: true }, s);
    }
  });

  it("ignores the phrase inside a code fence", () => {
    const text = "Jon, handover below.\n\n```\nNothing needed from you.\n```\n\nPaste it in the new chat.";
    assert.deepEqual(moveFrom(text, 5), { text: "Paste it in the new chat.", epoch: 5, unlabelled: true });
  });

  it("counts the phrase only at a sentence's start, so prose around it stays unlabelled", () => {
    for (const s of ["There is nothing needed from you.", "I said nothing needed from you earlier."]) {
      assert.deepEqual(moveFrom(endingOn(s), 5), { text: s, epoch: 5, unlabelled: true, noAsk: true }, s);
    }
  });

  it("leaves a labelled reply as it was, phrase or not", () => {
    assert.deepEqual(moveFrom("Nothing needed from you.\n\nYour move: go", 5), { text: "go", epoch: 5 });
    assert.deepEqual(moveFrom("Nothing needed from you.\n\nNothing for you: CI runs.", 5), {
      text: "CI runs.",
      epoch: 5,
      idle: true,
    });
  });

  it("still saves nothing for a headless run without a label", () => {
    assert.equal(moveFrom("Nothing needed from you.", 5, undefined, false), null);
  });

  it("gives the #3012 reply the move block the core's contract test reads", () => {
    const move = moveFrom(NOTHING_NEEDED_3012, 1000, "c");
    assert.ok(move);
    assert.equal(
      moveDescription(move),
      'Nothing to do until the screenshots arrive. ⟦move {"epoch":1000,"session":"c","idle":true}⟧',
    );
  });
});

// Replies that say the phrase yet ask Jon something: each must still wait
// on him. A false quiet hides a real ask; a false wait is only noise.
const waitsOnJon = (text: string): void => {
  const move = moveFrom(text, 5);
  assert.equal(move?.unlabelled, true, text);
  assert.equal(move?.idle, undefined, text);
};

describe("moveFrom, a reply with no label that asks nothing", () => {
  it("marks a progress reply noAsk, so it waits on Jon only once its helpers stop", () => {
    for (const last of ["Still waiting on the reviewer; I'll carry on when it reports.", "The build runs."]) {
      assert.deepEqual(moveFrom(`Done with the first lane.\n\n${last}`, 5), {
        text: last,
        epoch: 5,
        unlabelled: true,
        noAsk: true,
      });
    }
  });

  it("never marks one that asks, decides, or qualifies the phrase", () => {
    for (const text of [
      "The build runs.\n\nShall I carry on?",
      "The build runs.\n\n**Say go and I'll push the fix.**",
      "The build runs.\n\n**The fix is ready.**",
      `${DECISIONS.replace("Your move:", "Next:")}`,
      "Nothing needed from you until you merge the first pull request.\n\nThe build runs.",
    ]) {
      const move = moveFrom(text, 5);
      assert.equal(move?.noAsk, undefined, text);
      assert.equal(move?.idle, undefined, text);
    }
  });
});

describe("moveFrom, a reply that says nothing is needed yet asks", () => {
  it("lets any bold or italic last line that is no 'Nothing' line ask", () => {
    for (const last of [
      "**Say go and I'll push the fix**.",
      "**Say go and I'll push.** (#419)",
      "**Say go and I push.** ([PR](https://x/1))",
      "**Say go** and I'll push the fix.",
      "- **Say go and I'll push.**",
      "Jon, **say go and I'll push.**",
      "*Say go and I push.*",
    ]) {
      waitsOnJon(endingOn(`Nothing needed from you.\n\n${last}`));
    }
  });

  it("lets a plain ask verb or a question ask", () => {
    for (const text of [
      endingOn("Nothing needed from you.\n\nSay go and I'll push the fix."),
      endingOn("Nothing needed from you.\n\nShall I carry on?"),
      "Nothing needed from you. Shall I also open the follow-up issue?",
      "Nothing needed from you.\n\nWant me to carry on with the next issue?",
      "Nothing needed from you.\n\n```\n! cmux sidebar reload\n```\n\nPaste that into the main checkout.",
    ]) {
      waitsOnJon(text);
    }
  });

  it("lets a sentence after the phrase on the same line ask", () => {
    for (const s of [
      "Nothing needed from you for the build. Please approve the permission prompt in the other pane.",
      "Nothing needed from you on the code. The guard blocked the push; I need your yes to push the branch.",
      "Nothing needed from you. Except the merge.",
      "Nothing needed from you, e.g. no reload. Except the merge.",
    ]) {
      waitsOnJon(endingOn(s));
    }
  });

  it("reads a qualifier past a dot inside a word, and on the line below", () => {
    for (const s of [
      "Nothing needed from you for v1.2, but merge #419 later.",
      "Nothing needed from you on report-move.ts, but merge it.",
      "Nothing needed from you unless the screenshots look wrong.",
      "Nothing needed from you, only a look at the picture.",
      "Nothing needed from you until review; then a yes.",
      "Nothing needed from you now; next I need your pick on the colour.",
      "Nothing needed from you until CI passes, then say merge.",
      "Nothing needed from you until you merge the first pull request.",
      "Nothing needed from you\nexcept the merge.",
    ]) {
      waitsOnJon(endingOn(s));
    }
  });

  it("lets a 'Nothing' last line that asks or qualifies itself ask", () => {
    for (const last of [
      "**Nothing merges until you say go.**",
      "**Nothing ships until you pick a letter.**",
      "*Nothing happens until you paste the command above.*",
      "**Nothing moves before your go.**",
    ]) {
      waitsOnJon(
        `Jon, Cockpit quiet turns: the fix is on a branch.\n\n- **Hook** saves quiet replies as idle.\n\n**Status**\nNothing needed from you.\n\n${last}`,
      );
    }
  });

  it("reads 'just', 'till you', 'before you' and an ask verb on the phrase's line as qualifiers", () => {
    for (const s of [
      "Nothing needed from you, just a look at the picture.",
      "Nothing needed from you yet; merge #419 when CI is green.",
      "Nothing needed from you till you merge it.",
      "Nothing needed from you before you merge.",
    ]) {
      waitsOnJon(
        `Jon, Cockpit quiet turns: the fix is on a branch.\n\n- **Hook** saves quiet replies as idle.\n\n**Status**\n${s}`,
      );
    }
  });

  it("lets an ask verb that starts a clause or sentence ask", () => {
    waitsOnJon(endingOn("Nothing needed from you.\n\nNothing is running. Say go and I'll merge."));
    waitsOnJon(
      endingOn("Nothing needed from you.\n\n**Nothing else is needed here. The email is still yours to send.**"),
    );
    waitsOnJon(
      "Jon, Cockpit quiet turns: the fix is on a branch.\n\n**Status**\nNothing needed from you until CI passes; merge when it is green.",
    );
  });

  it("lets a decision or waiting title ask", () => {
    waitsOnJon(
      [
        "Jon, Cockpit card: one call.",
        "",
        "**Decision**",
        "The card shows the old line.",
        "",
        "**Options**",
        "**a)** Keep it. (lean)",
        "**b)** Drop it.",
        "",
        "**Status**",
        "Build runs. Nothing needed from you.",
        "",
        "**Give me the letter.**",
      ].join("\n"),
    );
    waitsOnJon(
      [
        "Jon, Cockpit card: fixed.",
        "",
        "**Also waiting on you**",
        "Merge the reload fix, #417.",
        "",
        "**Status**",
        "Build runs. Nothing needed from you.",
      ].join("\n"),
    );
  });

  it("does not count the phrase in a quote above other text", () => {
    waitsOnJon(
      "Jon, Cockpit: fixed.\n\n> Nothing needed from you.\n\nThat line used to turn the card red. Which colour should it be instead?",
    );
    waitsOnJon("Your last reply said:\n> Nothing needed from you.\n\nThat was wrong; I need a look at the card.");
  });
});

describe("lastLine", () => {
  it("is the reply's last line, marker and markdown stripped", () => {
    assert.equal(lastLine("Filed it.\n\n**Done:** nothing is running.\n"), "Done: nothing is running.");
    assert.equal(lastLine("Steps:\n\n1. Open it\n2. Close [it](https://x)"), "Close it");
  });

  it("drops a quote's marker and whole-line italics, and skips table rows", () => {
    assert.equal(lastLine("Body.\n\n> see above"), "see above");
    assert.equal(lastLine("Body.\n\n_Done._"), "Done.");
    assert.equal(lastLine("Summary.\n\n| #322 | ready |\n| --- | --- |"), "Summary.");
  });

  it("skips code fences, rules and headings", () => {
    assert.equal(lastLine("Paste this.\n\n```\nnpm run check\n```\n\n---\n"), "Paste this.");
    assert.equal(lastLine("Body.\n\n## Next"), "Body.");
  });

  it("cuts a long line with an ellipsis, and is null with nothing left", () => {
    const long = lastLine("word ".repeat(80));
    assert.ok(long && long.length === MAX_MOVE && long.endsWith("…"));
    assert.equal(lastLine("  \n---\n"), null);
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
    assert.equal(set({ text: "go", epoch: 10, unlabelled: false }).ok, false);
    const quoted = set({ text: "go", epoch: 10, unlabelled: true });
    assert.deepEqual(quoted.ok && quoted.state.moves.ws1, { text: "go", epoch: 10, unlabelled: true });
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

describe("the move description", () => {
  const full: SavedMove = {
    text: 'reply "1b 2a" ⟦x⟧.',
    epoch: 10,
    session: "s1",
    decisions: 2,
    leans: "1b 2a",
    idle: true,
  };

  it("round-trips a move, line first", () => {
    const d = moveDescription(full);
    assert.ok(d.startsWith(full.text + " "));
    assert.deepEqual(moveOfDescription(d), full);
    assert.deepEqual(moveOfDescription(moveDescription({ text: "go", epoch: 5 })), { text: "go", epoch: 5 });
    assert.ok(isMoveDescription(d));
  });

  it("reads nothing from Jon's own words or a broken tail", () => {
    for (const d of [undefined, "", "my notes", "go ⟦move {bad}⟧", 'go ⟦move {"epoch":"x"}⟧', 'go ⟦move {"epoch":1}'])
      assert.equal(moveOfDescription(d), null, String(d));
    assert.equal(isMoveDescription("my notes"), false);
    assert.equal(isMoveDescription(undefined), false);
  });
});

describe("deliver", () => {
  const move: SavedMove = { text: "go", epoch: 10, session: "s1" };
  // A fake cmux holding one workspace's description; `alter` stands in for
  // a cmux that cuts what it is given, `refuse` for one that says no, and
  // `unlisted` for one whose list does not hold the workspace. A null start
  // is a cmux that never answers.
  const fake = (
    start: string | null,
    opts: {
      refuse?: boolean;
      alter?: boolean;
      saved?: boolean;
      silent?: number;
      silentAfterWrite?: number;
      unlisted?: boolean;
    } = {},
  ) => {
    const calls: string[] = [];
    const logged: string[] = [];
    let held = start;
    // `silent` reads go unanswered first, as from a busy cmux, and
    // `silentAfterWrite` reads after the first write do the same.
    let silent = opts.silent ?? 0;
    let silentAfterWrite = opts.silentAfterWrite ?? 0;
    let wrote = false;
    let reads = 0;
    const d: Delivery = {
      read: (): DescriptionRead => {
        reads++;
        if (opts.unlisted) return { ok: false, why: "unlisted" };
        if (silent > 0 || (wrote && silentAfterWrite > 0)) {
          if (silent > 0) silent--;
          else silentAfterWrite--;
          return { ok: false, why: "silent" };
        }
        return held === null ? { ok: false, why: "silent" } : { ok: true, text: held };
      },
      write: (_ws, desc) => {
        calls.push(desc === null ? "clear" : "set");
        wrote = true;
        if (opts.refuse) return false;
        held = desc === null ? "" : opts.alter ? desc.slice(0, 20) : desc;
        return true;
      },
      hasSaved: () => opts.saved ?? false,
      save: (ws, m) => {
        calls.push(`save ${ws} ${m ? m.text : "null"}`);
        return { ok: true, changed: true };
      },
      build: () => {
        calls.push("build");
      },
      log: (line) => logged.push(line),
    };
    return { d, calls, logged, held: () => held, reads: () => reads };
  };

  it("sets an empty description and saves nothing, so nothing rebuilds", () => {
    const f = fake("");
    assert.equal(deliver("ws1", move, f.d), null);
    assert.deepEqual(f.calls, ["set"]);
    assert.equal(f.held(), moveDescription(move));
  });

  it("replaces an older move's description", () => {
    const f = fake(moveDescription({ text: "old", epoch: 1 }));
    deliver("ws1", move, f.d);
    assert.deepEqual(f.calls, ["set"]);
  });

  it("never overwrites Jon's own description: the move is saved instead", () => {
    const f = fake("Ship checklist");
    deliver("ws1", move, f.d);
    assert.deepEqual(f.calls, ["save ws1 go", "build"]);
    assert.equal(f.held(), "Ship checklist");
  });

  it("falls back to the saved map when cmux refuses, or cannot say what is there", () => {
    const refused = fake("", { refuse: true });
    deliver("ws1", move, refused.d);
    assert.deepEqual(refused.calls, ["set", "save ws1 go", "build"]);
    const unknown = fake(null);
    deliver("ws1", move, unknown.d);
    assert.deepEqual(unknown.calls, ["save ws1 go", "build"]);
  });

  it("clears a description cmux cut, then saves the move", () => {
    const f = fake("", { alter: true });
    deliver("ws1", move, f.d);
    assert.deepEqual(f.calls, ["set", "clear", "save ws1 go", "build"]);
    assert.equal(f.held(), "");
  });

  it("on a turn with no move clears a move's description, never Jon's, and drops a saved move", () => {
    const ours = fake(moveDescription(move));
    deliver("ws1", null, ours.d);
    assert.deepEqual(ours.calls, ["clear"]);
    const his = fake("Ship checklist");
    deliver("ws1", null, his.d);
    assert.deepEqual(his.calls, []);
    const saved = fake("", { saved: true });
    deliver("ws1", null, saved.d);
    assert.deepEqual(saved.calls, ["save ws1 null", "build"]);
  });

  it("asks once more when cmux does not answer the read, so one missed answer costs no rebuild", () => {
    const f = fake("", { silent: 1 });
    assert.equal(deliver("ws1", move, f.d), null);
    assert.deepEqual(f.calls, ["set"]);
    assert.deepEqual(f.logged, []);
  });

  it("says in the state log why each move went to the saved map", () => {
    const why = (f: ReturnType<typeof fake>) => {
      deliver("ws1-0000-long-id", move, f.d);
      return f.logged;
    };
    const saved = (reason: string) => [`saved the move for ws1-0000: ${reason}`];
    assert.deepEqual(why(fake(null)), saved("cmux did not answer the read, twice"));
    assert.deepEqual(why(fake("Ship checklist")), saved("the description holds other words"));
    assert.deepEqual(why(fake("", { refuse: true })), saved("cmux refused the description"));
    assert.deepEqual(why(fake("", { alter: true })), saved("cmux changed the description"));
    assert.deepEqual(why(fake("", { silentAfterWrite: 2 })), saved("cmux did not answer the read-back, twice"));
    assert.deepEqual(why(fake("", { unlisted: true })), saved("cmux does not list the workspace"));
  });

  it("asks once more for the read-back, so one missed answer never clears a description that landed", () => {
    const f = fake("", { silentAfterWrite: 1 });
    assert.equal(deliver("ws1", move, f.d), null);
    assert.deepEqual(f.calls, ["set"]);
    assert.equal(f.held(), moveDescription(move));
    assert.deepEqual(f.logged, []);
  });

  it("never asks twice about a workspace cmux does not list", () => {
    const f = fake("", { unlisted: true });
    deliver("ws1", move, f.d);
    assert.equal(f.reads(), 1);
    assert.deepEqual(f.calls, ["save ws1 go", "build"]);
  });

  it("reads once on a turn with no move, since the read only gates a clear", () => {
    const f = fake(null);
    assert.equal(deliver("ws1", null, f.d), null);
    assert.equal(f.reads(), 1);
    assert.deepEqual(f.calls, []);
  });

  it("logs nothing for a turn with no move", () => {
    const f = fake("", { saved: true });
    deliver("ws1", null, f.d);
    assert.deepEqual(f.logged, []);
  });

  it("passes a failed save on as a note, builds nothing, and logs that it could not save", () => {
    const f = fake("Ship checklist");
    f.d.save = () => ({ ok: false, error: "locked" });
    assert.equal(deliver("ws1-0000-long-id", move, f.d), "locked");
    assert.ok(!f.calls.includes("build"));
    assert.deepEqual(f.logged, ["could not save the move for ws1-0000 (the description holds other words): locked"]);
  });
});
