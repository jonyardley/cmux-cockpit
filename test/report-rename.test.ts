// The pure parts of the rename hook: finding the latest /rename in a
// transcript, deciding whether it goes to cmux, and reading cmux's group
// list. The cmux calls, the stamp file and the stdin/env plumbing are not
// covered.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { groupNamesFrom, latestTitle, renameFor } from "../scripts/hooks/report-rename.ts";

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

describe("renameFor", () => {
  it("passes a new name on", () => {
    assert.equal(renameFor("Design Review", null, ["Cockpit"]), "Design Review");
    assert.equal(renameFor("Design Review", "Parallel lanes", []), "Design Review");
  });

  it("passes nothing when there is no rename or it was already passed", () => {
    assert.equal(renameFor(null, null, []), null);
    assert.equal(renameFor("Design Review", "Design Review", []), null);
  });

  it("skips a name a group goes by, whatever its case", () => {
    assert.equal(renameFor("cockpit ", null, ["Cockpit", "Background"]), null);
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
