// The pure parts of the rename hook: finding the latest /rename in a
// transcript, the group-name clash, reading cmux's group
// list, splitting a read into whole lines, loading the saved stamp, and
// naming the session for the agents panel.
// The cmux calls, the file reads and writes and the stdin/env plumbing are
// not covered.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  clashesWithGroup,
  firstPrompt,
  groupNamesFrom,
  latestTitle,
  parseStamp,
  promptText,
  sessionName,
  wholeLines,
  withName,
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
    const stamp = { offset: 120, seen: "Design Review", handled: null, prompt: "Fix it", named: "title:Design Review" };
    assert.deepEqual(parseStamp(JSON.stringify(stamp)), stamp);
  });

  it("reads a stamp from before names were kept from the start again, keeping what was handled", () => {
    const old = { offset: 120, seen: "Design Review", handled: "Design Review" };
    assert.deepEqual(parseStamp(JSON.stringify(old)), {
      offset: 0,
      seen: null,
      handled: "Design Review",
      prompt: null,
      named: null,
    });
  });

  it("starts empty for a missing, broken or wrong-shaped stamp", () => {
    const empty = { offset: 0, seen: null, handled: null, prompt: null, named: null };
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

  it("drops a leading reminder and image markers but keeps the words after them", () => {
    assert.equal(promptText("<system-reminder>x</system-reminder>\n[Image #2] Why is this red?"), "Why is this red?");
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
