import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { applyPublished } from "../scripts/hooks/report-published.ts";
import { emptyState, type State } from "../scripts/state-config.ts";
import {
  ensureUrlToken,
  parseSetUrl,
  readApplyWrite,
  readUrlToken,
  tokenMatches,
  unreadableCopyOf,
  writePollMaps,
  writePublished,
  writeSubagents,
} from "../scripts/state-url.ts";

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
      published: {},
      prOrigins: {},
      asking: {},
      moves: {},
      prSeen: {},
      mergeKept: {},
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

describe("writePollMaps and the poll status", () => {
  const dir = mkdtempSync(join(tmpdir(), "state-url-poll-"));
  after(() => rmSync(dir, { recursive: true, force: true }));
  const keep = (runs: State["subagents"]) => runs;

  it("saves the poll status in the same pass as the PR maps", () => {
    const path = join(dir, "saves.json");
    assert.deepEqual(writePollMaps(path, {}, {}, keep, { okEpoch: 100 }), { ok: true, changed: true });
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")).poll, { okEpoch: 100 });
  });

  it("keeps the saved status when none is given", () => {
    const path = join(dir, "keeps.json");
    writePollMaps(path, {}, {}, keep, { okEpoch: 100, error: "signed-out" });
    assert.deepEqual(writePollMaps(path, {}, {}, keep), { ok: true, changed: false });
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")).poll, { okEpoch: 100, error: "signed-out" });
  });

  it("seeds a workspace's seen PR state with the state before this poll, and keeps the rest", () => {
    const path = join(dir, "seen.json");
    const pr = { number: 1, url: "https://github.com/o/r/pull/1", status: "open" as const, branch: "b" };
    const green = { ...pr, mergeable: true as const, checks: [{ name: "build", state: "pass" as const }] };
    writePollMaps(path, { was: green, kept: green }, {}, keep);
    const first = JSON.parse(readFileSync(path, "utf8")).prSeen;
    assert.deepEqual(first, { was: "other", kept: "other" }, "no PR before the first poll");
    writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, "utf8")), prSeen: { kept: "merged" } }));
    writePollMaps(path, { was: { ...green, status: "merged" }, kept: green, fresh: pr }, {}, keep);
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")).prSeen, {
      kept: "merged",
      was: "ready",
      fresh: "other",
    });
  });

  it("replaces the saved status whole, so a cleared error is gone", () => {
    const path = join(dir, "replaces.json");
    writePollMaps(path, {}, {}, keep, { okEpoch: 100, error: "unavailable" });
    assert.deepEqual(writePollMaps(path, {}, {}, keep, { okEpoch: 400 }), { ok: true, changed: true });
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")).poll, { okEpoch: 400 });
  });

  it("removes the saved status when given null", () => {
    const path = join(dir, "removes.json");
    writePollMaps(path, {}, {}, keep, { okEpoch: 100 });
    assert.deepEqual(writePollMaps(path, {}, {}, keep, null), { ok: true, changed: true });
    assert.equal(JSON.parse(readFileSync(path, "utf8")).poll, undefined);
  });

  it("is no change when the status is the same", () => {
    const path = join(dir, "same.json");
    writePollMaps(path, {}, {}, keep, { okEpoch: 100 });
    assert.deepEqual(writePollMaps(path, {}, {}, keep, { okEpoch: 100 }), { ok: true, changed: false });
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

describe("writePublished", () => {
  const dirs: string[] = [];
  after(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });
  function tempFile(): string {
    const dir = mkdtempSync(join(tmpdir(), "state-url-published-"));
    dirs.push(dir);
    return join(dir, "state.json");
  }

  const link = (id: string, epoch: number, title = "T"): State["published"][string] => ({
    url: "https://claude.ai/artifact/" + id,
    title,
    kind: "page",
    workspace: "w1",
    epoch,
  });

  it("adds, then updates a republished link in place, leaving the rest of the state alone", () => {
    const path = tempFile();
    readApplyWrite(path, "projectOverride.w1", '"alpha"');
    const [a, b] = [link("a", 100), link("b", 200)];
    writePublished(path, (m) => applyPublished(m, a, 100));
    writePublished(path, (m) => applyPublished(m, b, 200));
    const result = writePublished(path, (m) => applyPublished(m, link("a", 300, "New"), 300));
    assert.deepEqual(result, { ok: true, changed: true });
    const saved = JSON.parse(readFileSync(path, "utf8"));
    assert.deepEqual(Object.keys(saved.published), [b.url, a.url]);
    assert.equal(saved.published[a.url].title, "New");
    assert.deepEqual(saved.projectOverride, { w1: "alpha" });
  });

  it("sees no change when nothing differs, and drops a malformed entry on the way out", () => {
    const path = tempFile();
    writePublished(path, () => ({ [link("a", 1).url]: link("a", 1) }));
    assert.deepEqual(
      writePublished(path, (m) => m),
      { ok: true, changed: false },
    );
    writePublished(path, () => ({ [link("a", 1).url]: link("a", 1, "") }));
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")).published, {});
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

describe("the URL token", () => {
  const token = "a".repeat(64);

  it("parses a token param and leaves it out when there is none", () => {
    const parsed = parseSetUrl(`cmux-cockpit://set?key=projectOverride.w1&token=${token}`);
    assert.deepEqual(parsed, { ok: true, key: "projectOverride.w1", value: null, token });
    const bare = parseSetUrl("cmux-cockpit://set?key=projectOverride.w1");
    assert.equal(bare.ok && "token" in bare, false);
  });

  it("refuses a missing token", () => {
    assert.equal(tokenMatches(undefined, token), false);
    assert.equal(tokenMatches("", token), false);
  });

  it("refuses a wrong token, of the same length or not", () => {
    assert.equal(tokenMatches("b".repeat(64), token), false);
    assert.equal(tokenMatches("a".repeat(63), token), false);
    assert.equal(tokenMatches(`${token}a`, token), false);
  });

  it("refuses every token when the install has none", () => {
    assert.equal(tokenMatches(token, null), false);
    assert.equal(tokenMatches("", ""), false);
  });

  it("accepts the right token", () => {
    assert.equal(tokenMatches(token, token), true);
  });

  it("makes a 64-character hex token readable by this user only, and keeps it", () => {
    const dir = mkdtempSync(join(tmpdir(), "state-url-token-"));
    try {
      const path = join(dir, "config", "url-token");
      assert.equal(readUrlToken(path), null);
      const made = ensureUrlToken(path);
      assert.match(made, /^[0-9a-f]{64}$/);
      assert.equal(statSync(path).mode & 0o777, 0o600);
      assert.equal(ensureUrlToken(path), made);
      assert.equal(readUrlToken(path), made);
      // An empty file, from a first build cut off mid-write, gets a fresh token.
      writeFileSync(path, "");
      const remade = ensureUrlToken(path);
      assert.match(remade, /^[0-9a-f]{64}$/);
      assert.equal(statSync(path).mode & 0o777, 0o600);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("an unreadable state file is kept aside before a write replaces it", () => {
  const dirs: string[] = [];
  after(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });
  function tempFile(): string {
    const dir = mkdtempSync(join(tmpdir(), "state-url-broken-"));
    dirs.push(dir);
    return join(dir, "state.json");
  }

  it("uses the name build.ts looks for", () => {
    assert.equal(unreadableCopyOf("config/state.json"), "config/state.json.unreadable.bak");
  });

  it("copies a corrupt file byte for byte, then writes the replacement", () => {
    const path = tempFile();
    const broken = Buffer.from('{ "dismissed": { half a file \u00e9\n');
    writeFileSync(path, broken);
    assert.deepEqual(readApplyWrite(path, "projectOverride.w1", '"alpha"'), { ok: true, changed: true });
    assert.deepEqual(readFileSync(unreadableCopyOf(path)), broken);
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")).projectOverride, { w1: "alpha" });
  });

  it("keeps a file that parses but is not an object too", () => {
    const path = tempFile();
    writeFileSync(path, "[1, 2]");
    readApplyWrite(path, "projectOverride.w1", '"alpha"');
    assert.equal(readFileSync(unreadableCopyOf(path), "utf8"), "[1, 2]");
  });

  it("never copies over an earlier backup, keeping a second breakage beside it", () => {
    const path = tempFile();
    writeFileSync(path, "first broken");
    readApplyWrite(path, "projectOverride.w1", '"alpha"');
    writeFileSync(path, "second broken");
    assert.deepEqual(readApplyWrite(path, "projectOverride.w2", '"beta"'), { ok: true, changed: true });
    assert.equal(readFileSync(unreadableCopyOf(path), "utf8"), "first broken");
    const extra = readdirSync(dirname(path)).filter((f) => /^state\.json\.unreadable\.\d+\.bak$/.test(f));
    assert.equal(extra.length, 1);
    assert.equal(readFileSync(join(dirname(path), extra[0] ?? ""), "utf8"), "second broken");
  });

  it("makes no second copy when the broken file matches the one already kept", () => {
    const path = tempFile();
    writeFileSync(path, "same broken");
    writeFileSync(unreadableCopyOf(path), "same broken");
    readApplyWrite(path, "projectOverride.w1", '"alpha"');
    assert.deepEqual(readdirSync(dirname(path)).sort(), ["state.json", "state.json.unreadable.bak"]);
  });

  it("makes no backup of a missing file or a good one", () => {
    const path = tempFile();
    readApplyWrite(path, "projectOverride.w1", '"alpha"');
    readApplyWrite(path, "projectOverride.w2", '"beta"');
    assert.equal(existsSync(unreadableCopyOf(path)), false);
  });
});
