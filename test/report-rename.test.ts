// The pure parts of the rename hook: finding the latest /rename in a
// transcript, the group-name clash, reading cmux's group
// list, splitting a read into whole lines and loading the saved stamp.
// The cmux calls, the file reads and writes and the stdin/env plumbing are
// not covered.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  clashesWithGroup,
  groupNamesFrom,
  latestTitle,
  parseStamp,
  wholeLines,
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
    const stamp = { offset: 120, seen: "Design Review", handled: null };
    assert.deepEqual(parseStamp(JSON.stringify(stamp)), stamp);
  });

  it("starts empty for a missing, broken or wrong-shaped stamp", () => {
    const empty = { offset: 0, seen: null, handled: null };
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
