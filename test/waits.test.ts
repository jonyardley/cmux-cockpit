// The Cockpit's saved waits on Jon in the agents panel (#388): each lands
// on the workspace's agents as the core lays it (a stop on its session, CI
// on a finished lead, a park on a lead not already waiting, a stand-in
// with no agent), so the panel's Needs you and the Cockpit's agree, with
// no wait counted twice. The saved state is seeded before the panel's
// modules load, as they read it at import.

// Clock times print in the Mac's own zone; pinned so they read the same anywhere.
process.env.TZ = "UTC";

import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import type { SavedWait } from "../scripts/state-config.ts";
import { ago, EPOCH, seed } from "./support/snapshot.ts";

const ci = (kind: SavedWait["kind"], since: number, extra: Partial<SavedWait> = {}): SavedWait => ({
  kind,
  since,
  key: since,
  ...extra,
});

const stuck = ci("ci_stuck", ago(2400), { check: "build", queued: ago(2400), detail: "Tabs" });
const failed = ci("ci_failing", ago(600), { detail: "Tabs" });
const park = ci("park", ago(900), { detail: "notes-app#42 needs a decision" });
const stop = (agent: string): SavedWait => ({
  kind: "stopped",
  since: ago(300),
  key: ago(300),
  agent,
  detail: "error",
});

const pr = (checks: { name: string; state: "pending"; queued?: number; started?: number }[]) => ({
  url: "https://github.com/o/r/pull/12",
  number: 12,
  status: "open" as const,
  branch: "b",
  title: "Tabs",
  checks,
});

const r = seed({
  state: {
    prs: {
      idle: pr([{ name: "build", state: "pending", queued: ago(2400) }]),
      runs: pr([{ name: "build", state: "pending", queued: ago(2500), started: ago(2400) }]),
    },
    waits: {
      idle: [stuck],
      runs: [stuck],
      gone: [stuck],
      work: [failed],
      ask: [failed],
      stop: [stop("s1"), failed],
      none: [park],
      both: [failed, park],
      lone: [park],
      mix: [stop("m2")],
    },
  },
});
const { agent, ws } = await import("./support/fixtures.ts");
const { dismissNeeds } = await import("../src/shared/needs.ts");
const w = await import("../src/shared/waits.ts");
const m = await import("../src/agents/model.ts");
const d = await import("../src/agents/details.ts");

// A real ask: needs_input with activity right up to it, so never a nudge.
const asking = (id: string) => agent("needs_input", { id, sinceEpoch: ago(120), lastActivityAt: ago(120) });
const idle = (id: string, at = 200) => agent("idle", { id, sinceEpoch: ago(at), lastActivityAt: ago(at) });
const working = (id: string) => agent("working", { id, sinceEpoch: ago(60), lastActivityAt: ago(10) });

const AGENTS: Record<string, () => Agent[]> = {
  idle: () => [idle("i1")],
  runs: () => [idle("r1")],
  gone: () => [idle("g1")],
  work: () => [working("w1")],
  ask: () => [asking("k1")],
  stop: () => [working("s1"), idle("s2")],
  none: () => [],
  both: () => [idle("b1")],
  lone: () => [working("l1")],
  mix: () => [asking("m1"), idle("m2")],
};

function select(id: string): void {
  r.data.workspaces = Object.keys(AGENTS).map((k) => ws(k, { selected: k === id, agents: AGENTS[k]?.() ?? [] }));
}

beforeEach(() => {
  r.data.epoch = EPOCH;
});

describe("saved waits in Needs you", () => {
  it("counts a CI wait on a finished lead, in its own words, with no Dismiss", () => {
    select("idle");
    assert.deepEqual(m.currentAsk(), {
      text: "CI stuck: build queued at 13:06, no runner since",
      count: 1,
      dismissLabel: "",
    });
  });

  it("tells a stuck check that runs from one still queued, by the PR's own copy", () => {
    select("runs");
    assert.equal(m.currentAsk()?.text, "CI stuck: build running since 13:06");
    select("gone");
    assert.equal(m.currentAsk()?.text, "CI stuck: build stuck since 13:06", "no PR to read: neutral words");
  });

  it("leaves CI off a lead still working, as the Cockpit does", () => {
    select("work");
    assert.equal(m.currentAsk(), null);
    assert.equal(d.cardShows.waits(), false, "nor does the card list it");
  });

  it("never counts a wait twice on an agent already asking", () => {
    select("ask");
    const ask = m.currentAsk();
    assert.equal(ask?.count, 1);
    assert.equal(ask?.dismissLabel, "Dismiss");
    assert.notEqual(ask?.text.startsWith("CI failed"), true, "the agent's own ask speaks");
    assert.equal(d.cardShows.waits(), false);
  });

  it("puts a stop on its own session, which then carries the card and not CI", () => {
    select("stop");
    assert.deepEqual(m.currentAsk(), { text: "Stopped: on an error", count: 1, dismissLabel: "" });
    assert.deepEqual(
      d.waitRows().map((x) => [x.key, x.word, x.age, x.detail, x.last]),
      [["w:stopped:s1", "Stopped", "5m", "agent 1, on an error", true]],
    );
  });

  it("stands a wait in for a workspace with no agent left", () => {
    select("none");
    assert.deepEqual(m.currentAsk(), { text: "Parked: notes-app#42 needs a decision", count: 1, dismissLabel: "" });
  });

  it("puts a park on no lead CI already made wait", () => {
    select("both");
    assert.equal(m.currentAsk()?.text, "CI failed: Tabs");
    assert.deepEqual(
      d.waitRows().map((x) => x.word),
      ["CI failed"],
    );
  });

  it("puts a park on a lead not waiting on Jon, working or not", () => {
    select("lone");
    assert.equal(m.currentAsk()?.text, "Parked: notes-app#42 needs a decision");
  });

  it("counts an agent's ask and a stop beside it as two, Dismiss for the ask alone", () => {
    select("mix");
    assert.deepEqual(m.currentAsk(), { text: "2 things wait on you", count: 2, dismissLabel: "Dismiss" });
  });

  it("shows the wait once Jon dismisses the agent's own ask, without Dismiss", () => {
    select("ask");
    dismissNeeds(r.data.workspaces?.find((x) => x.selected));
    assert.deepEqual(m.currentAsk(), { text: "CI failed: Tabs", count: 1, dismissLabel: "" });
  });
});

describe("the Waiting on you card", () => {
  it("lists the waits that land, with age and why", () => {
    select("idle");
    assert.equal(d.cardShows.waits(), true);
    assert.deepEqual(d.waitRows(), [
      {
        key: "w:ci_stuck:",
        word: "CI stuck",
        age: "40m",
        detail: "build queued at 13:06, no runner since",
        last: true,
      },
    ]);
    assert.equal(d.detailsNote(), "", "a card shows");
  });
});

describe("withWaits", () => {
  it("counts an ask and a wait together when both land", () => {
    const out = w.withWaits([asking("x"), idle("y")], [stop("y")]);
    assert.deepEqual(
      out.agents.map((a) => a.status),
      ["needs_input", "needs_input"],
    );
    assert.deepEqual(out.added, [stop("y")]);
  });

  it("does not add a stop on an agent already asking, though it shows", () => {
    const out = w.withWaits([asking("x")], [stop("x")]);
    assert.equal(out.shown.length, 1);
    assert.equal(out.added.length, 0);
  });

  it("leaves a workspace with no agent and no CI or park as it is", () => {
    const out = w.withWaits([], [stop("x")]);
    assert.equal(out.standIn, false);
    assert.equal(out.shown.length, 0);
  });
});

describe("wait words", () => {
  it("says how a session stopped, in the Cockpit's words", () => {
    const at = (detail?: string): string => w.waitDetail({ ...stop("x"), ...(detail ? { detail } : {}) }, undefined);
    assert.deepEqual(["error", "gone", "silent", "odd"].map(at), ["on an error", "mid-turn", "silent", "odd"]);
    const bare: SavedWait = { kind: "stopped", since: 1, key: 1, agent: "x" };
    assert.equal(w.waitDetail(bare, undefined), "");
  });

  it("falls back to the saved words for stuck CI with no time, and its word alone with none", () => {
    assert.equal(w.waitDetail(ci("ci_stuck", 1, { detail: "Tabs" }), undefined), "Tabs");
    assert.equal(w.waitDetail(ci("ci_stuck", 1), undefined), "");
    assert.equal(w.waitLine(ci("merge_ready", 1), undefined), "Ready to merge");
    assert.equal(w.waitDetail(ci("ci_stuck", 1, { queued: ago(60) }), undefined), "a check stuck since 13:45");
  });

  it("reads a clock time in the Mac's zone, and none for a bad input", () => {
    assert.equal(w.clockTime(ago(2400)), "13:06");
    assert.equal(w.clockTime(0), "");
    assert.equal(w.clockTime(Number.NaN), "");
  });

  it("finds no waits for a workspace the map does not hold", () => {
    assert.deepEqual(w.waitsFor("elsewhere"), []);
  });
});
