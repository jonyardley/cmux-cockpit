// Reading a transcript from a hook: the tail as lines and the main chat's
// reply in one line.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { readTail, replyFrom, tailLines } from "../scripts/hooks/transcript.ts";

const NOW = 1_800_000_000;
const line = (text: string, epoch: number, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    type: "assistant",
    uuid: "m" + epoch,
    timestamp: new Date(epoch * 1000).toISOString(),
    message: { role: "assistant", content: [{ type: "text", text }] },
    ...extra,
  });

describe("tailLines", () => {
  it("keeps every line of a whole file", () => {
    assert.deepEqual(tailLines("a\nb\n", false), ["a", "b", ""]);
  });

  it("drops the partial first line of a read that began mid-file", () => {
    assert.deepEqual(tailLines('ial"}\n{"a":1}\n', true), ['{"a":1}', ""]);
  });
});

describe("readTail", () => {
  it("reads a small file whole, and only the last bytes of a bigger one, from a line start", () => {
    const dir = mkdtempSync(join(tmpdir(), "transcript-"));
    try {
      const path = join(dir, "t.jsonl");
      writeFileSync(path, "first line\nsecond\nthird\n");
      assert.deepEqual(readTail(path, 1024), ["first line", "second", "third", ""]);
      assert.deepEqual(readTail(path, 10), ["third", ""]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("replyFrom", () => {
  it("reads the main chat's text reply", () => {
    assert.deepEqual(replyFrom(line("Opened #21.", NOW)), { uuid: "m" + NOW, epoch: NOW, text: "Opened #21." });
  });

  it("skips a subagent's reply, a tool result, a reply with no text, and a broken line", () => {
    assert.equal(replyFrom(line("Opened #21.", NOW, { isSidechain: true })), null);
    assert.equal(replyFrom(JSON.stringify({ type: "user", message: { content: "#21" } })), null);
    assert.equal(replyFrom(line("", NOW)), null);
    assert.equal(replyFrom('{"type":"assistant",'), null);
  });

  it("reads a plain string content too", () => {
    const raw = JSON.stringify({
      type: "assistant",
      uuid: "u1",
      timestamp: new Date(NOW * 1000).toISOString(),
      message: { content: "PR 21 is up." },
    });
    assert.equal(replyFrom(raw)?.text, "PR 21 is up.");
  });
});
