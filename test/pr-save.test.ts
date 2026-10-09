// Issue #300: the native PR poll is the one writer of config/state.json's
// `prs` verdicts. Its SavePrs effect reaches scripts/pr-save.ts as JSON
// (the shape native/runner/tests/effects.json pins for the Rust side),
// pr-save writes it under the state file's lock, scripts/pr-poll.ts only
// drops closed workspaces without undoing such a write, and the agents
// panel, baked from the file, then says what the card says.

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { dropClosed } from "../scripts/pr-poll.ts";
import { parsePrSave } from "../scripts/pr-save.ts";
import { type SavedPr, validateState } from "../scripts/state-config.ts";
import { writePollMaps, writePrEntries } from "../scripts/state-url.ts";

const dir = mkdtempSync(join(tmpdir(), "pr-save-"));
after(() => rmSync(dir, { recursive: true, force: true }));
const fileIn = (name: string, state: unknown): string => {
  const path = join(dir, name);
  writeFileSync(path, JSON.stringify(state));
  return path;
};
const read = (path: string) => validateState(JSON.parse(readFileSync(path, "utf8")));

const pr = (n: number, extra: Partial<SavedPr> = {}): SavedPr => ({
  number: n,
  url: `https://github.com/o/r/pull/${n}`,
  status: "open",
  branch: "feat",
  ...extra,
});

// The SavePrs entry the Rust tests hold the bridge's JSON to.
const effects: unknown = JSON.parse(
  readFileSync(join(import.meta.dirname, "..", "native", "runner", "tests", "effects.json"), "utf8"),
);
const native = (Array.isArray(effects) ? effects : []).find((e) => e && typeof e === "object" && "SavePrs" in e)
  ?.SavePrs?.prs;

describe("parsePrSave", () => {
  it("reads the native effect's JSON, nulls and whole floats included, as the contract's PRs", () => {
    assert.ok(native, "effects.json holds a SavePrs entry");
    const input = parsePrSave(JSON.stringify(native));
    assert.ok(input.ok);
    assert.deepEqual(input.remove, ["W2"]);
    assert.equal(input.skipped, 0);
    assert.deepEqual(input.set, {
      W1: pr(7, {
        mergeable: true,
        title: "Poll",
        additions: 3,
        deletions: 1,
        checks: [{ name: "check", state: "pass" }],
      }),
    });
  });

  it("skips an entry the contract refuses rather than deleting what the file holds", () => {
    const input = parsePrSave(JSON.stringify({ a: { number: 0, url: "nope" }, b: pr(2) }));
    assert.ok(input.ok);
    assert.deepEqual(input.set, { b: pr(2) });
    assert.deepEqual(input.remove, []);
    assert.equal(input.skipped, 1);
  });

  it("refuses what is not a JSON map", () => {
    for (const bad of [undefined, "", "{", "[]", "null", '"x"']) {
      assert.equal(parsePrSave(bad).ok, false, String(bad));
    }
  });
});

describe("writePrEntries", () => {
  it("sets and deletes only the entries given, keeps the rest, and says when nothing changed", () => {
    const path = fileIn("entries.json", { prs: { a: pr(1), b: pr(2), c: pr(3) }, dismissed: { x: { s: 1 } } });
    assert.deepEqual(writePrEntries(path, { a: pr(1, { mergeable: true }) }, ["b"]), { ok: true, changed: true });
    const state = read(path);
    assert.deepEqual(state.prs, { a: pr(1, { mergeable: true }), c: pr(3) });
    assert.deepEqual(Object.keys(state.dismissed), ["x"], "other maps stay");
    assert.deepEqual(writePrEntries(path, { a: pr(1, { mergeable: true }) }, ["b"]), { ok: true, changed: false });
  });
});

describe("the TypeScript poll beside the native writer", () => {
  it("drops closed workspaces and never undoes an answer written after it read the file", () => {
    const path = fileIn("poll.json", { prs: { a: pr(1), gone: pr(2) } });
    // The poll has read the file and listed workspaces a and b; the native
    // poll then writes b's PR before the poll writes.
    const prs = dropClosed([
      { id: "a", directory: "/a" },
      { id: "b", directory: "/b" },
    ]);
    writePrEntries(path, { b: pr(3) }, []);
    const keep = <T>(runs: T): T => runs;
    assert.deepEqual(writePollMaps(path, prs, {}, keep), { ok: true, changed: true, maps: ["prs"] });
    assert.deepEqual(read(path).prs, { a: pr(1), b: pr(3) });
  });
});

// The agents panel, baked from a file the native poll wrote. The file held
// the old poller's stale draft for W1; the native answer says ready.
const stale = fileIn("panel.json", { prs: { W1: pr(7, { draft: true }) } });
const saved = parsePrSave(JSON.stringify(native));
assert.ok(saved.ok);
writePrEntries(stale, saved.set, saved.remove);
(globalThis as Record<string, unknown>).__STATE__ = read(stale);

const { installRenderer } = await import("./support/renderer.ts");
const r = installRenderer();
const { agent, ws } = await import("./support/fixtures.ts");
const chips = await import("../src/cockpit/card-chips.ts");
const list = await import("../src/agents/pr-list.ts");
const model = await import("../src/agents/model.ts");

describe("the agents panel reads the native poll's verdict (issue #300)", () => {
  it("says ready in the Pull requests row and This workspace, as the card does", () => {
    r.data.workspaces = [ws("W1", { branch: "feat", selected: true, agents: [agent("working")] })];
    r.data.epoch++;
    const chip = chips.chipsFor(r.data.workspaces[0], false).find((c) => c.id === "pr");
    assert.ok(chip && "health" in chip);
    assert.deepEqual({ state: chip.state, health: chip.health }, { state: "ready", health: "ready" }, "the card");
    const entry = list.prs().find((e) => e.pr.number === 7);
    assert.ok(entry, "the row is listed");
    assert.equal(list.prChipText(entry), "ready", "the Pull requests row");
    assert.equal(list.prChipHealth(entry), "ready");
    assert.equal(model.currentPr()?.state, "ready", "This workspace");
  });
});
