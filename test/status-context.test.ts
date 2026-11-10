// The status line's context writer: what it reads from the status line's
// JSON, when it writes, and that it keeps whatever the description already
// holds before its tail. Also the move hook keeping the context tail when it
// writes or clears a move.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { DescriptionRead } from "../scripts/hooks/description.ts";
import { type Delivery, deliver } from "../scripts/hooks/report-move.ts";
import {
  accountOf,
  type ContextDelivery,
  contextFrom,
  due,
  REFRESH_S,
  report,
} from "../scripts/hooks/status-context.ts";
import { moveDescription, type SavedContext, splitContext, withContext } from "../scripts/state-config.ts";

const PAYLOAD = {
  context_window: {
    total_input_tokens: 177_816,
    context_window_size: 1_000_000,
    current_usage: {
      input_tokens: 2,
      output_tokens: 7,
      cache_creation_input_tokens: 209,
      cache_read_input_tokens: 177_605,
    },
    used_percentage: 17.6,
  },
  rate_limits: {
    five_hour: { used_percentage: 10, resets_at: 1_794_307_200 },
    seven_day: { used_percentage: 2, resets_at: 1_794_877_200 },
  },
};

describe("contextFrom", () => {
  it("reads the window and both plan limits, in whole percents", () => {
    assert.deepEqual(contextFrom(PAYLOAD, 5), {
      epoch: 5,
      used: 18,
      tokens: 177_816,
      size: 1_000_000,
      hour: 10,
      hourReset: 1_794_307_200,
      week: 2,
      weekReset: 1_794_877_200,
    });
  });

  it("falls back to the total input when there is no last call yet, and leaves out what is missing", () => {
    assert.deepEqual(contextFrom({ context_window: { used_percentage: 0, total_input_tokens: 40 } }, 5), {
      epoch: 5,
      used: 0,
      tokens: 40,
    });
  });

  it("tags the figures with the account when one is given", () => {
    assert.equal(contextFrom(PAYLOAD, 5, "acme")?.account, "acme");
    assert.equal(contextFrom(PAYLOAD, 5)?.account, undefined);
  });

  it("reports nothing without a used percentage", () => {
    assert.equal(contextFrom({ context_window: {} }, 5), null);
    assert.equal(contextFrom("junk", 5), null);
  });
});

describe("accountOf", () => {
  it("names a second Claude folder's account, and none for the main folder", () => {
    assert.equal(accountOf("/Users/jon/.claude-acme"), "acme");
    assert.equal(accountOf("/Users/jon/.claude-ACME/"), "acme");
    assert.equal(accountOf("/Users/jon/.claude"), undefined);
    assert.equal(accountOf(undefined), undefined);
    assert.equal(accountOf("/Users/jon/.claude-a]b"), undefined);
  });
});

describe("due", () => {
  const c: SavedContext = { epoch: 1, used: 18, tokens: 100, hour: 10 };
  it("ignores the time seen and the exact token count, so a busy status line writes rarely", () => {
    assert.equal(due(null, c), true);
    assert.equal(due(c, { ...c, epoch: 9, tokens: 150 }), false);
    assert.equal(due(c, { ...c, used: 19 }), true);
    assert.equal(due(c, { ...c, hour: 11 }), true);
    assert.equal(due(c, { ...c, week: 1 }), true);
    assert.equal(due(c, { ...c, epoch: 1 + REFRESH_S }), true);
  });
});

function fakeCmux(start: string | null, opts: { refuse?: boolean } = {}) {
  let held = start ?? "";
  let last: SavedContext | null = null;
  const writes: (string | null)[] = [];
  const d: ContextDelivery = {
    read: (): DescriptionRead => (start === null ? { ok: false, why: "silent" } : { ok: true, text: held }),
    write: (_ws, desc) => {
      writes.push(desc);
      if (opts.refuse) return false;
      held = desc ?? "";
      return true;
    },
    last: () => last,
    remember: (c) => {
      last = c;
    },
  };
  return { d, writes, held: () => held };
}

describe("report", () => {
  const c: SavedContext = { epoch: 1, used: 18, hour: 10 };

  it("puts the tail after Jon's words or a move, replacing an older tail", () => {
    const move = moveDescription({ text: "go", epoch: 1 });
    for (const body of ["Ship checklist", move, ""]) {
      const f = fakeCmux(withContext(body, { epoch: 0, used: 3 }));
      assert.equal(report("ws1", c, f.d), null);
      assert.deepEqual(splitContext(f.held()), { body, context: c });
    }
  });

  it("writes once while nothing moves, and again once the refresh is due", () => {
    const f = fakeCmux("");
    report("ws1", c, f.d);
    report("ws1", { ...c, epoch: 2 }, f.d);
    assert.equal(f.writes.length, 1);
    report("ws1", { ...c, epoch: 1 + REFRESH_S }, f.d);
    assert.equal(f.writes.length, 2);
    f.writes.length = 0;
    report("ws1", { ...c, epoch: 2 + REFRESH_S }, f.d);
    assert.equal(f.writes.length, 0);
    report("ws1", { ...c, used: 19, epoch: 3 + REFRESH_S }, f.d);
    assert.equal(f.writes.length, 1);
  });

  it("says why when cmux cannot say or refuses, and tries again next time", () => {
    assert.equal(report("ws1", c, fakeCmux(null).d), "cmux did not answer");
    const refused = fakeCmux("", { refuse: true });
    assert.equal(report("ws1", c, refused.d), "cmux refused the description");
    assert.equal(report("ws1", c, refused.d), "cmux refused the description");
    assert.equal(refused.writes.length, 2);
  });

  it("says when cmux does not list the workspace", () => {
    const f = fakeCmux("");
    f.d.read = () => ({ ok: false, why: "unlisted" });
    assert.equal(report("ws1", c, f.d), "cmux does not list the workspace");
  });
});

describe("the move hook beside the context tail", () => {
  const tail: SavedContext = { epoch: 1, used: 18 };
  const move = { text: "go", epoch: 5 };

  const fake = (start: string, alter = false) => {
    let held = start;
    const calls: string[] = [];
    const d: Delivery = {
      read: () => ({ ok: true, text: held }),
      write: (_ws, desc) => {
        calls.push(desc === null ? "clear" : "set");
        held = desc === null ? "" : alter ? desc.slice(0, 10) : desc;
        return true;
      },
      hasSaved: () => false,
      save: (_ws, m) => {
        calls.push(`save ${m ? m.text : "null"}`);
        return { ok: true, changed: false };
      },
      build: () => {},
      log: () => {},
    };
    return { d, calls, held: () => held };
  };

  it("writes the move before the tail it found", () => {
    const f = fake(withContext("", tail));
    assert.equal(deliver("ws1", move, f.d), null);
    assert.equal(f.held(), withContext(moveDescription(move), tail));
  });

  it("still treats Jon's words with a tail as his", () => {
    const f = fake(withContext("Ship checklist", tail));
    deliver("ws1", move, f.d);
    assert.deepEqual(f.calls, ["save go"]);
    assert.equal(f.held(), withContext("Ship checklist", tail));
  });

  it("on a turn with no move keeps only the tail", () => {
    const f = fake(withContext(moveDescription(move), tail));
    deliver("ws1", null, f.d);
    assert.equal(f.held(), withContext("", tail));
  });

  it("takes a move cmux altered off again, keeping the tail", () => {
    const f = fake(withContext("", tail), true);
    deliver("ws1", move, f.d);
    assert.deepEqual(f.calls, ["set", "set", "save go"]);
    assert.equal(f.held(), withContext("", tail).slice(0, 10));
  });
});
