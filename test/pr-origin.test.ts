// Where a PR came from: report-pr.ts records which chat opened it, and
// report-mention.ts finds the paragraph where that chat first named it.
// The file reads and the rebuild are not covered; the state write is.

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  applyMentions,
  findMentions,
  mentionPattern,
  PENDING_MAX_AGE_S,
  paragraphWith,
  pendingFor,
  replyFrom,
  tailLines,
} from "../scripts/hooks/report-mention.ts";
import { addOrigin, ORIGIN_MAX_AGE_S, originFrom } from "../scripts/hooks/report-pr.ts";
import { cleanMention, MAX_MENTION, type SavedPrOrigin, validateState } from "../scripts/state-config.ts";
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

const line = (text: string, epoch: number, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    type: "assistant",
    uuid: "m" + epoch,
    timestamp: new Date(epoch * 1000).toISOString(),
    message: { role: "assistant", content: [{ type: "text", text }] },
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

  it("keeps a mention an earlier record of the same PR found", () => {
    const mention = { text: "Opened #21.", message: "m1", epoch: NOW - 5 };
    const next = addOrigin({ [URL]: origin({ epoch: NOW - 10, mention }) }, origin(), NOW);
    assert.deepEqual(next[URL], origin({ mention }));
  });

  it("drops the earlier mention when a different chat records the PR", () => {
    const mention = { text: "Opened #21.", message: "m1", epoch: NOW - 5 };
    const earlier = origin({ session: "other", epoch: NOW - 10, mention });
    const next = addOrigin({ [URL]: earlier }, origin(), NOW);
    assert.deepEqual(next[URL], origin());
  });
});

describe("mentionPattern", () => {
  const re = mentionPattern(origin());
  it("matches the link, #N and PR N", () => {
    for (const t of [`see ${URL}`, "opened #21.", "PR 21 is up", "pr #21 is up", "(#21)"]) assert.ok(re.test(t), t);
  });

  it("does not match a longer number, a longer link, or an HTML entity", () => {
    for (const t of ["#210", "#2100 and PR 212", `${URL}0`, "&#21;", "issue21"]) assert.ok(!re.test(t), t);
  });
});

describe("paragraphWith", () => {
  const re = mentionPattern(origin());
  it("takes the paragraph that names the PR, on one line, markdown markers dropped", () => {
    const text = "Jon, done.\n\n1. **#21**: the `flaky` test.\n   See [the PR](https://x).\n\nYour move: merge.";
    assert.equal(paragraphWith(text, re), "#21: the flaky test. See the PR.");
  });

  it("is null when no paragraph names it", () => {
    assert.equal(paragraphWith("Nothing here about #22.", re), null);
  });

  it("cuts a long paragraph to MAX_MENTION, ending in an ellipsis", () => {
    const out = paragraphWith(`#21 ${"word ".repeat(200)}`, re) ?? "";
    assert.ok(out.length <= MAX_MENTION);
    assert.ok(out.endsWith("…"));
  });

  it("cuts by UTF-16 length, so an emoji paragraph still ends in an ellipsis and fits", () => {
    const out = paragraphWith(`#21 ${"😀".repeat(400)}`, re) ?? "";
    assert.ok(out.length <= MAX_MENTION, String(out.length));
    assert.ok(out.endsWith("…"));
    assert.ok(!/[\ud800-\udbff]…$/.test(out), "no half emoji before the ellipsis");
  });
});

describe("cleanMention", () => {
  it("keeps a paragraph that fits as it is, and a paragraph one over gets the ellipsis", () => {
    assert.equal(cleanMention("x".repeat(MAX_MENTION)), "x".repeat(MAX_MENTION));
    assert.equal(cleanMention("x".repeat(MAX_MENTION + 1)), `${"x".repeat(MAX_MENTION - 1)}…`);
  });

  it("drops the space before the ellipsis, and is null for nothing usable", () => {
    const out = cleanMention(`${"x".repeat(MAX_MENTION - 2)} tail`) ?? "";
    assert.equal(out, `${"x".repeat(MAX_MENTION - 2)}…`);
    assert.equal(cleanMention("  \n "), null);
    assert.equal(cleanMention(5), null);
  });
});

describe("tailLines", () => {
  it("keeps every line of a whole file", () => {
    assert.deepEqual(tailLines("a\nb\n", false), ["a", "b", ""]);
  });

  it("drops the partial first line of a read that began mid-file", () => {
    assert.deepEqual(tailLines('ial"}\n{"a":1}\n', true), ['{"a":1}', ""]);
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

describe("findMentions", () => {
  it("takes the first reply naming each PR from its create on", () => {
    const other = origin({ url: "https://github.com/o/r/pull/30", number: 30 });
    const lines = [
      line("Earlier, issue #21 came up.", NOW - 60),
      line("Opened #21: the fix.\n\nNext.", NOW + 5),
      line("And #21 again, with PR 30.", NOW + 9),
    ];
    const found = findMentions(lines, [origin(), other]);
    assert.deepEqual(found.get(URL), { text: "Opened #21: the fix.", message: "m" + (NOW + 5), epoch: NOW + 5 });
    assert.equal(found.get(other.url)?.text, "And #21 again, with PR 30.");
  });

  it("finds nothing when no reply names it", () => {
    assert.equal(findMentions([line("All done.", NOW + 1)], [origin()]).size, 0);
  });
});

describe("pendingFor and applyMentions", () => {
  const mention = { text: "Opened #21.", message: "m1", epoch: NOW + 1 };

  it("waits only on the session's recent origins with no mention", () => {
    const map = {
      [URL]: origin(),
      a: origin({ url: "a", session: "other" }),
      b: origin({ url: "b", mention }),
      c: origin({ url: "c", epoch: NOW - PENDING_MAX_AGE_S - 1 }),
    };
    assert.deepEqual(
      pendingFor(map, "sess", NOW).map((o) => o.url),
      [URL],
    );
  });

  it("sets a found mention, never replacing one already saved", () => {
    const saved = { ...mention, text: "First." };
    const map = { [URL]: origin(), b: origin({ url: "b", mention: saved }) };
    const next = applyMentions(
      map,
      new Map([
        [URL, mention],
        ["b", mention],
      ]),
    );
    assert.deepEqual(next[URL]?.mention, mention);
    assert.deepEqual(next.b?.mention, saved);
  });
});

describe("prOrigins in the state file", () => {
  it("keeps a good origin and drops a bad one, or only its bad mention", () => {
    const good = origin({ mention: { text: "Opened #21.", message: "m1", epoch: NOW } });
    const badMention = { ...origin({ url: "https://github.com/o/r/pull/22", number: 22 }), mention: { text: "" } };
    const state = validateState({
      prOrigins: {
        [URL]: good,
        [badMention.url]: badMention,
        "https://evil.example/pull/1": { ...good, url: "https://evil.example/pull/1" },
        "https://github.com/o/r/pull/23": { ...good, url: "https://github.com/o/r/pull/23", number: 0 },
        "https://github.com/o/r/pull/24": { ...good, url: "https://github.com/o/r/pull/24", surface: 5 },
      },
    });
    assert.deepEqual(Object.keys(state.prOrigins), [URL, badMention.url]);
    assert.deepEqual(state.prOrigins[URL], good);
    assert.equal(state.prOrigins[badMention.url]?.mention, undefined);
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
