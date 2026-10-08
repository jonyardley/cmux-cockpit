// The pure parts of the rename hook: finding the latest /rename in a
// transcript, the group-name clash, reading cmux's group and workspace
// lists, splitting a read into whole lines, loading the saved stamp,
// naming the session for the agents panel, the issue a prompt names and
// the name a `/ws` gives.
// The cmux calls, the file reads and writes and the stdin/env plumbing are
// not covered.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  clashesWithGroup,
  firstPrompt,
  groupNamesFrom,
  issueIn,
  latestTitle,
  leadingIssue,
  parseStamp,
  promptFromEvent,
  promptText,
  sessionName,
  titleFrom,
  wholeLines,
  withIssue,
  withName,
  wsTitle,
  wsWords,
} from "../scripts/hooks/report-rename.ts";

const titled = (t: string): string => JSON.stringify({ type: "custom-title", customTitle: t, sessionId: "s" });
const named = (t: string): string => JSON.stringify({ type: "agent-name", agentName: t, sessionId: "s" });
const prompt = JSON.stringify({ type: "user", message: { role: "user", content: 'say "custom-title" please' } });

describe("latestTitle", () => {
  it("is null for a session never renamed", () => {
    assert.equal(latestTitle([prompt, named("Other"), ""]), null);
  });

  it("takes the last rename, trimmed", () => {
    assert.equal(latestTitle([titled("Parallel lanes"), prompt, titled("  Design Review "), prompt]), "Design Review");
  });

  it("skips a cut or broken line and a blank name", () => {
    assert.equal(latestTitle([titled("Kept"), '{"type":"custom-title","customTitle":"Cut', titled("   ")]), "Kept");
  });
});

describe("clashesWithGroup", () => {
  it("is true for a name a group goes by, whatever its case or spacing", () => {
    assert.equal(clashesWithGroup("cockpit ", ["Cockpit", "Background"]), true);
  });

  it("is false for any other name, or with no groups", () => {
    assert.equal(clashesWithGroup("Design Review", ["Cockpit"]), false);
    assert.equal(clashesWithGroup("Design Review", []), false);
  });
});

describe("wholeLines", () => {
  it("leaves a line still being written for the next read", () => {
    const buf = Buffer.from(`${titled("A")}\n{"type":"cus`);
    const { lines, consumed } = wholeLines(buf);
    assert.equal(consumed, Buffer.byteLength(titled("A")) + 1);
    assert.equal(latestTitle(lines), "A");
  });

  it("counts bytes, not characters", () => {
    assert.equal(wholeLines(Buffer.from("é\n")).consumed, 3);
  });

  it("takes nothing from a read with no line end", () => {
    assert.equal(wholeLines(Buffer.from("partial")).consumed, 0);
    assert.equal(wholeLines(Buffer.alloc(0)).consumed, 0);
  });
});

describe("parseStamp", () => {
  it("reads a saved stamp", () => {
    const stamp = { offset: 120, seen: "Design Review", handled: null, prompt: "Fix it" };
    assert.deepEqual(parseStamp(JSON.stringify(stamp)), stamp);
  });

  it("reads a stamp from before names were kept from the start again, keeping what was handled", () => {
    const old = { offset: 120, seen: "Design Review", handled: "Design Review" };
    assert.deepEqual(parseStamp(JSON.stringify(old)), {
      offset: 0,
      seen: null,
      handled: "Design Review",
      prompt: null,
    });
  });

  it("starts empty for a missing, broken or wrong-shaped stamp", () => {
    const empty = { offset: 0, seen: null, handled: null, prompt: null };
    assert.deepEqual(parseStamp(null), empty);
    assert.deepEqual(parseStamp("{"), empty);
    assert.deepEqual(parseStamp(JSON.stringify({ offset: -1, seen: null, handled: null })), empty);
    assert.deepEqual(parseStamp(JSON.stringify({ offset: 1, seen: 3, handled: null })), empty);
  });
});

describe("groupNamesFrom", () => {
  it("reads each group's name", () => {
    const out = JSON.stringify({ groups: [{ name: "Background" }, { name: "Cockpit" }, { ref: "x" }] });
    assert.deepEqual(groupNamesFrom(out), ["Background", "Cockpit"]);
  });

  it("is empty for output it cannot read", () => {
    assert.deepEqual(groupNamesFrom("not json"), []);
    assert.deepEqual(groupNamesFrom("{}"), []);
  });
});

const user = (content: unknown, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ type: "user", message: { role: "user", content }, sessionId: "s", ...extra });

describe("promptFromEvent", () => {
  it("takes the prompt from a message event only", () => {
    const base = { session_id: "s", transcript_path: "/t.jsonl" };
    assert.equal(
      promptFromEvent({ ...base, hook_event_name: "UserPromptSubmit", prompt: "Fix the cards" }),
      "Fix the cards",
    );
    assert.equal(promptFromEvent({ ...base, hook_event_name: "Stop", stop_hook_active: false }), null);
    assert.equal(promptFromEvent({ ...base, hook_event_name: "Stop", prompt: "Fix the cards" }), null);
  });
});

describe("promptText", () => {
  it("keeps what Jon typed, on one line", () => {
    assert.equal(promptText("  Real names on\nagent rows  "), "Real names on agent rows");
  });

  it("finds nothing in a slash command, a shell escape or harness text", () => {
    assert.equal(promptText("<command-name>/clear</command-name>\n<command-message>clear</command-message>"), null);
    assert.equal(promptText("<bash-input>npm run doctor</bash-input>"), null);
    assert.equal(promptText("<local-command-stdout></local-command-stdout>"), null);
    assert.equal(promptText("[Request interrupted by user]"), null);
  });

  it("drops reminders anywhere and image markers but keeps the words around them", () => {
    assert.equal(promptText("<system-reminder>x</system-reminder>\n[Image #2] Why is this red?"), "Why is this red?");
    assert.equal(promptText("Fix it <system-reminder>As you answer</system-reminder>"), "Fix it");
  });

  it("finds nothing the agents panel would blank: a bare path, a pasted-text marker, no words", () => {
    assert.equal(promptText("~/dev/app/src/foo.ts"), null);
    assert.equal(promptText("[Pasted text #1 +40 lines]"), null);
    assert.equal(promptText("1 2 3"), null);
  });
});

describe("firstPrompt", () => {
  it("skips harness lines, tool results and side chats for the first real prompt", () => {
    const lines = [
      user("<command-name>/clear</command-name>"),
      user("Caveat: generated by local commands", { isMeta: true }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "user" }] } }),
      user([{ type: "tool_result", content: "ok" }]),
      user("A helper's brief", { isSidechain: true }),
      user("Summary of the chat so far", { isCompactSummary: true }),
      "{broken",
      user([{ type: "image" }, { type: "text", text: "Real names on agent rows" }]),
      user("A later prompt"),
    ];
    assert.equal(firstPrompt(lines), "Real names on agent rows");
  });

  it("passes over a prompt the panel would blank for a later readable one", () => {
    assert.equal(
      firstPrompt([user("[Pasted text #1 +40 lines]"), user("Why is the build red?")]),
      "Why is the build red?",
    );
  });

  it("finds none when no line holds one", () => {
    assert.equal(firstPrompt([user("<bash-input>ls</bash-input>"), ""]), null);
  });
});

describe("sessionName", () => {
  it("takes a rename over the first prompt, and the prompt when there is none", () => {
    assert.deepEqual(sessionName("Design Review", "Fix it"), { name: "Design Review", from: "title" });
    assert.deepEqual(sessionName(null, "Fix it"), { name: "Fix it", from: "prompt" });
    assert.deepEqual(sessionName("   ", "Fix it"), { name: "Fix it", from: "prompt" });
    assert.equal(sessionName(null, null), null);
  });
});

describe("withName", () => {
  it("sets the session's name and moves it last", () => {
    const a = { name: "A", from: "prompt" } as const;
    const b = { name: "B", from: "prompt" } as const;
    const next = withName({ s1: a, s2: b }, "s1", { name: "A2", from: "title" });
    assert.deepEqual(Object.entries(next), [
      ["s2", b],
      ["s1", { name: "A2", from: "title" }],
    ]);
  });
});

describe("issueIn", () => {
  it("finds #123, issue 123, issue #123 and an issue link", () => {
    assert.equal(issueIn("fix #123 please"), 123);
    assert.equal(issueIn("work on issue 45"), 45);
    assert.equal(issueIn("Issue #7 is back"), 7);
    assert.equal(issueIn("see https://github.com/jonyardley/cmux-cockpit/issues/301"), 301);
    assert.equal(issueIn("#9: reload"), 9);
  });

  it("takes the first issue a prompt names", () => {
    assert.equal(issueIn("#12 then issue 34"), 12);
    assert.equal(issueIn("issue 34 and #12"), 34);
  });

  it("finds none in a prompt without one", () => {
    assert.equal(issueIn("tidy the lanes"), null);
    assert.equal(issueIn(""), null);
  });

  it("is not fooled by a pull request, a colour, a link fragment, an entity or #0", () => {
    assert.equal(issueIn("review PR #292"), null);
    assert.equal(issueIn("pull request 88 is red"), null);
    assert.equal(issueIn("https://github.com/x/y/pull/77"), null);
    assert.equal(issueIn("make it #d97757"), null);
    assert.equal(issueIn("page#12 and &#39;"), null);
    assert.equal(issueIn("#0"), null);
  });

  it("skips a pull request to find an issue after it", () => {
    assert.equal(issueIn("PR #292 closes #281"), 281);
  });
});

describe("leadingIssue and withIssue", () => {
  it("reads the issue number a name starts with", () => {
    assert.equal(leadingIssue("#123 Fix reload"), 123);
    assert.equal(leadingIssue("#123"), 123);
    assert.equal(leadingIssue("Fix #123"), null);
    assert.equal(leadingIssue("#123abc"), null);
  });

  it("puts the number at the front", () => {
    assert.equal(withIssue("Fix reload", 123), "#123 Fix reload");
    assert.equal(withIssue("  ", 123), "#123");
  });
});

describe("wsWords", () => {
  it("takes the words after /ws, on one line", () => {
    assert.equal(wsWords("/ws Fix reload"), "Fix reload");
    assert.equal(wsWords("  /ws   Fix\n reload  "), "Fix reload");
  });

  it("is empty for a bare /ws and null for any other prompt", () => {
    assert.equal(wsWords("/ws"), "");
    assert.equal(wsWords("/ws   "), "");
    assert.equal(wsWords("/wsfoo bar"), null);
    assert.equal(wsWords("rename with /ws later"), null);
    assert.equal(wsWords("/rename x"), null);
  });
});

describe("wsTitle", () => {
  it("keeps the workspace's issue number", () => {
    assert.equal(wsTitle("Fix reload", "#123 Old name"), "#123 Fix reload");
  });

  it("takes a number the words bring instead", () => {
    assert.equal(wsTitle("#45 New text", "#123 Old name"), "#45 New text");
  });

  it("is the words alone when the workspace has no number or its name is unknown", () => {
    assert.equal(wsTitle("Fix reload", "cmux/r4-cards"), "Fix reload");
    assert.equal(wsTitle("Fix reload", null), "Fix reload");
  });
});

describe("titleFrom", () => {
  const list = JSON.stringify({
    workspaces: [
      { id: "A-1", ref: "workspace:1", title: "Background" },
      { id: "B-2", ref: "workspace:2", title: "#12 Lanes" },
    ],
  });

  it("finds a workspace by id or ref", () => {
    assert.equal(titleFrom(list, "B-2"), "#12 Lanes");
    assert.equal(titleFrom(list, "workspace:1"), "Background");
  });

  it("is null for a workspace not listed or output it cannot read", () => {
    assert.equal(titleFrom(list, "C-3"), null);
    assert.equal(titleFrom("not json", "A-1"), null);
    assert.equal(titleFrom("{}", "A-1"), null);
  });
});
