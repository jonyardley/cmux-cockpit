import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { emptyState, type State } from "../scripts/state-config.ts";
import { parseSetUrl, readApplyWrite, writeSubagents } from "../scripts/state-url.ts";

describe("parseSetUrl", () => {
  it("parses a set with a value", () => {
    assert.deepEqual(parseSetUrl("cmux-cockpit://set?key=projectOverride.w1&value=%22alpha%22"), {
      ok: true,
      key: "projectOverride.w1",
      value: '"alpha"',
    });
  });

  it("parses a delete (no value param) as value: null", () => {
    assert.deepEqual(parseSetUrl("cmux-cockpit://set?key=projectOverride.w1"), {
      ok: true,
      key: "projectOverride.w1",
      value: null,
    });
  });

  it("refuses the wrong scheme", () => {
    const parsed = parseSetUrl("https://set?key=projectOverride.w1");
    assert.equal(parsed.ok, false);
  });

  it("refuses the wrong host", () => {
    const parsed = parseSetUrl("cmux-cockpit://get?key=projectOverride.w1");
    assert.equal(parsed.ok, false);
  });

  it("refuses a missing key", () => {
    const parsed = parseSetUrl("cmux-cockpit://set?value=%22alpha%22");
    assert.equal(parsed.ok, false);
  });

  it("refuses extra junk params", () => {
    const parsed = parseSetUrl("cmux-cockpit://set?key=projectOverride.w1&value=%22alpha%22&evil=1");
    assert.equal(parsed.ok, false);
  });

  it("refuses any path, and never echoes raw input in an error", () => {
    assert.equal(parseSetUrl("cmux-cockpit://set/x?key=projectOverride.w1").ok, false);
    const bad = parseSetUrl("secret value not a url");
    assert.deepEqual(bad, { ok: false, error: "not a URL" });
  });

  it("refuses text that is not a URL at all", () => {
    const parsed = parseSetUrl("not a url");
    assert.equal(parsed.ok, false);
  });
});

describe("readApplyWrite", () => {
  const dirs: string[] = [];
  after(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });
  function tempFile(): string {
    const dir = mkdtempSync(join(tmpdir(), "state-url-"));
    dirs.push(dir);
    return join(dir, "state.json");
  }

  it("treats a missing file as empty state and writes the new entry", () => {
    const path = tempFile();
    const result = readApplyWrite(path, "projectOverride.w1", '"alpha"');
    assert.deepEqual(result, { ok: true, changed: true });
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), {
      dismissed: {},
      projectOverride: { w1: "alpha" },
      projects: {},
      prs: {},
      ownPrs: {},
      subagents: {},
      ui: {},
    });
  });

  it("treats a corrupt file as empty state", () => {
    const path = tempFile();
    writeFileSync(path, "{ not json");
    const result = readApplyWrite(path, "projectOverride.w1", '"alpha"');
    assert.deepEqual(result, { ok: true, changed: true });
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")).projectOverride, { w1: "alpha" });
  });

  it("sets then deletes the same entry", () => {
    const path = tempFile();
    assert.deepEqual(readApplyWrite(path, "projectOverride.w1", '"alpha"'), { ok: true, changed: true });
    assert.deepEqual(readApplyWrite(path, "projectOverride.w1", '"alpha"'), { ok: true, changed: false });
    assert.deepEqual(readApplyWrite(path, "projectOverride.w1", null), { ok: true, changed: true });
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), emptyState());
  });

  it("leaves the file untouched when the input is refused", () => {
    const path = tempFile();
    writeFileSync(path, JSON.stringify({ dismissed: {}, projectOverride: { w1: "alpha" } }));
    const before = readFileSync(path, "utf8");
    const result = readApplyWrite(path, "projectOverride.w1", "not json");
    assert.equal(result.ok, false);
    assert.equal(readFileSync(path, "utf8"), before);
  });
});

describe("writeSubagents", () => {
  const dirs: string[] = [];
  after(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });
  function tempFile(): string {
    const dir = mkdtempSync(join(tmpdir(), "state-url-subagents-"));
    dirs.push(dir);
    return join(dir, "state.json");
  }

  const run = { id: "toolu_1", session: "s1", label: "Review", startedEpoch: 100 };

  it("writes the map update returns, leaving the rest of the state alone", () => {
    const path = tempFile();
    readApplyWrite(path, "projectOverride.w1", '"alpha"');
    const result = writeSubagents(path, () => ({ w1: [run] }));
    assert.deepEqual(result, { ok: true, changed: true });
    const saved = JSON.parse(readFileSync(path, "utf8"));
    assert.deepEqual(saved.subagents, { w1: [run] });
    assert.deepEqual(saved.projectOverride, { w1: "alpha" });
  });

  it("passes the current map to update, so a fold can read it back", () => {
    const path = tempFile();
    writeSubagents(path, () => ({ w1: [run] }));
    let seen: State["subagents"] | undefined;
    writeSubagents(path, (subagents) => {
      seen = subagents;
      return subagents;
    });
    assert.deepEqual(seen, { w1: [run] });
  });

  it("sorts workspace keys, so reordering them is not seen as a change", () => {
    const path = tempFile();
    writeSubagents(path, () => ({ w2: [run], w1: [run] }));
    assert.deepEqual(
      writeSubagents(path, (subagents) => subagents),
      { ok: true, changed: false },
    );
    assert.deepEqual(Object.keys(JSON.parse(readFileSync(path, "utf8")).subagents), ["w1", "w2"]);
  });

  it("drops an entry the update clears back to empty state", () => {
    const path = tempFile();
    writeSubagents(path, () => ({ w1: [run] }));
    const result = writeSubagents(path, () => ({}));
    assert.deepEqual(result, { ok: true, changed: true });
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")).subagents, {});
  });

  it("validates on the way out, dropping a malformed run rather than writing it", () => {
    const path = tempFile();
    writeSubagents(path, () => ({ w1: [run] }));
    // An empty label is a valid SavedSubagent to the type checker; only
    // validateState's isLabel (a runtime check) rejects it.
    const bad: State["subagents"] = { w1: [{ id: "toolu_1", session: "s1", label: "", startedEpoch: 100 }] };
    const result = writeSubagents(path, () => bad);
    assert.deepEqual(result, { ok: true, changed: true });
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")).subagents, {});
  });
});

describe("readApplyWrite locking", () => {
  it("waits out a live lock, then fails rather than writing", () => {
    const dir = mkdtempSync(join(tmpdir(), "state-lock-"));
    const path = join(dir, "state.json");
    writeFileSync(`${path}.lock`, "");
    assert.throws(() => readApplyWrite(path, "projectOverride.w1", '"alpha"'), /locked/);
    rmSync(dir, { recursive: true, force: true });
  });
});
