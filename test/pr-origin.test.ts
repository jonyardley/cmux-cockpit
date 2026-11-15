// Where a PR came from: report-pr.ts records which chat opened it.
// The file reads and the rebuild are not covered; the state write is.

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { addOrigin, ORIGIN_MAX_AGE_S, originFrom } from "../scripts/hooks/report-pr.ts";
import { type SavedPrOrigin, validateState } from "../scripts/state-config.ts";
import { writePrOrigins } from "../scripts/state-url.ts";

const URL = "https://github.com/o/r/pull/21";
const NOW = 1_800_000_000;
const ENV = { CMUX_WORKSPACE_ID: "ws1", CMUX_SURFACE_ID: "s1" };
const origin = (extra: Partial<SavedPrOrigin> = {}): SavedPrOrigin => ({
  url: URL,
  number: 21,
  workspace: "ws1",
  surface: "s1",
  session: "sess",
  epoch: NOW,
  ...extra,
});

describe("originFrom", () => {
  it("names the session, workspace and terminal, with the number from the link", () => {
    assert.deepEqual(originFrom(URL, { session_id: "sess" }, ENV, NOW), origin());
  });

  it("leaves the terminal out when cmux gave none", () => {
    const o = originFrom(URL, { session_id: "sess" }, { CMUX_WORKSPACE_ID: "ws1" }, NOW);
    assert.equal(o?.surface, undefined);
    assert.equal(o?.workspace, "ws1");
  });

  it("is null without a session, a workspace, or a numbered link", () => {
    assert.equal(originFrom(URL, {}, ENV, NOW), null);
    assert.equal(originFrom(URL, { session_id: "sess" }, {}, NOW), null);
    assert.equal(originFrom("https://github.com/o/r/pulls", { session_id: "sess" }, ENV, NOW), null);
    assert.equal(originFrom(URL, { session_id: "__proto__" }, ENV, NOW), null);
  });
});

describe("addOrigin", () => {
  it("adds the origin last and drops ones past the age limit", () => {
    const old = origin({ url: "https://github.com/o/r/pull/1", number: 1, epoch: NOW - ORIGIN_MAX_AGE_S - 1 });
    const kept = origin({ url: "https://github.com/o/r/pull/2", number: 2, epoch: NOW - 10 });
    const next = addOrigin({ [old.url]: old, [kept.url]: kept }, origin(), NOW);
    assert.deepEqual(Object.keys(next), [kept.url, URL]);
  });

  it("replaces an earlier record of the same PR with the newer one", () => {
    const earlier = origin({ session: "other", epoch: NOW - 10 });
    const next = addOrigin({ [URL]: earlier }, origin(), NOW);
    assert.deepEqual(next[URL], origin());
  });
});

describe("prOrigins in the state file", () => {
  it("keeps a good origin, drops a bad one, and drops an old saved mention", () => {
    const good = origin();
    const old = {
      ...origin({ url: "https://github.com/o/r/pull/22", number: 22 }),
      mention: { text: "Opened #22.", message: "m22", epoch: NOW },
    };
    const state = validateState({
      prOrigins: {
        [URL]: good,
        [old.url]: old,
        "https://evil.example/pull/1": { ...good, url: "https://evil.example/pull/1" },
        "https://github.com/o/r/pull/23": { ...good, url: "https://github.com/o/r/pull/23", number: 0 },
        "https://github.com/o/r/pull/24": { ...good, url: "https://github.com/o/r/pull/24", surface: 5 },
      },
    });
    assert.deepEqual(Object.keys(state.prOrigins), [URL, old.url]);
    assert.deepEqual(state.prOrigins[URL], good);
    assert.deepEqual(state.prOrigins[old.url], origin({ url: old.url, number: 22 }));
  });

  it("drops an origin whose number disagrees with its link, or whose link is not its key", () => {
    const other = "https://github.com/o/r/pull/22";
    const state = validateState({
      prOrigins: {
        [URL]: origin({ number: 22 }),
        [other]: origin(),
        "https://github.com/o/r/pull/23": origin({ url: "https://github.com/o/r/pull/23", number: 23 }),
      },
    });
    assert.deepEqual(Object.keys(state.prOrigins), ["https://github.com/o/r/pull/23"]);
  });

  it("is written under the lock, and a no-op write is not a change", () => {
    const dir = mkdtempSync(join(tmpdir(), "pr-origin-"));
    try {
      const path = join(dir, "state.json");
      const first = writePrOrigins(path, (m) => addOrigin(m, origin(), NOW));
      assert.deepEqual(first, { ok: true, changed: true });
      assert.deepEqual(JSON.parse(readFileSync(path, "utf8")).prOrigins[URL], origin());
      assert.deepEqual(
        writePrOrigins(path, (m) => m),
        { ok: true, changed: false },
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
