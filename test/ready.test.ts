// The Ready state on cockpit cards (issue #53): an agent that finished while
// Jon was elsewhere, with output he has not read. __STATE__ is set before the
// renderer import, as in prs-saved.test.ts, so a saved PR can be green.

import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { emptyState } from "../scripts/state-config.ts";

const saved = { url: "https://github.com/o/r/pull/45", status: "open", branch: "feat" } as const;
const pass = [{ name: "build", state: "pass" }] as const;
// The cast holds because the renderer support reads __STATE__ off globalThis by name.
(globalThis as Record<string, unknown>).__STATE__ = {
  ...emptyState(),
  prs: {
    green: { ...saved, number: 45, mergeable: true, checks: pass },
    failing: { ...saved, number: 46, checks: [{ name: "build", state: "fail" }] },
    running: { ...saved, number: 47, checks: [{ name: "build", state: "pending" }] },
    draft: { ...saved, number: 48, draft: true, checks: pass },
    open: { ...saved, number: 49 },
  },
};

const { installRenderer } = await import("./support/renderer.ts");
const r = installRenderer();
const { agent, group, ws } = await import("./support/fixtures.ts");
const status = await import("../src/cockpit/status.ts");
const state = await import("../src/cockpit/state.ts");
const model = await import("../src/cockpit/card-chips.ts");
const { hasChipsRow } = await import("../src/cockpit/chips.ts");
const needs = await import("../src/shared/needs.ts");
const prs = await import("../src/shared/prs.ts");

const now = () => r.data.epoch;

// An agent that worked until `ago` seconds back, then settled on `st`.
const finished = (st: AgentStatus, ago = 360, extra: Partial<Agent> = {}) =>
  agent(st, { lastActivityAt: now() - ago, sinceEpoch: now() - ago, ...extra });

// A finished workspace with unread output.
const readyWs = (id = "w", extra: Partial<Workspace> = {}) =>
  ws(id, { unread: 2, agents: [finished("idle")], ...extra });

beforeEach(() => {
  r.data.epoch += 100;
  r.data.workspaces = [];
  r.data.groups = [];
  r.data.selectedId = null;
  r.calls.length = 0;
});

describe("isReady", () => {
  it("is ready when an agent went idle or ended after working and the output is unread", () => {
    assert.equal(status.isReady(readyWs()), true);
    assert.equal(status.isReady(readyWs("e", { agents: [finished("ended")] })), true);
  });

  it("is not ready once the output is read", () => {
    assert.equal(status.isReady(readyWs("w", { unread: 0 })), false);
    assert.equal(status.isReady(ws("w", { agents: [finished("idle")] })), false);
  });

  it("clears while the workspace is open", () => {
    assert.equal(status.isReady(readyWs("w", { selected: true })), false);
  });

  it("clears the moment Jon taps the card, before cmux publishes the selection", () => {
    const w = readyWs("tapped");
    state.selectWorkspace("tapped");
    assert.equal(status.isReady(w), false);
    assert.equal(status.isReady(readyWs("other")), true);
    // Once cmux agrees, the workspace's own flag takes over again.
    r.data.selectedId = "tapped";
    assert.equal(status.isReady(readyWs("tapped", { selected: true })), false);
    assert.equal(status.isReady(readyWs("tapped")), true);
  });

  it("reports an ended agent that worked, beside a fresh idle session that never did", () => {
    const fresh = agent("idle", { sinceEpoch: now() - 30 });
    const w = readyWs("pair", { agents: [finished("ended", 600), fresh] });
    assert.equal(status.isReady(w), true);
    assert.equal(status.statusLine(w), "Finished 10m");
  });

  it("needs the agent to have worked: no recorded activity is not a finished run", () => {
    assert.equal(status.isReady(ws("w", { unread: 1, agents: [agent("idle", { sinceEpoch: now() - 60 })] })), false);
  });

  it("is never ready while an agent works or really asks", () => {
    assert.equal(status.isReady(readyWs("w", { agents: [finished("working")] })), false);
    assert.equal(status.isReady(readyWs("w", { agents: [finished("idle"), finished("working", 5)] })), false);
    const ask = agent("needs_input", { kind: "claude", lastActivityAt: now() - 3, sinceEpoch: now() - 2 });
    assert.equal(status.isReady(readyWs("w", { agents: [ask] })), false);
  });

  it("stays off for a real ask Jon dismissed: the agent stopped to ask, it did not finish", () => {
    const ask = agent("needs_input", { kind: "claude", lastActivityAt: now() - 3, sinceEpoch: now() - 2 });
    const w = readyWs("dismissed", { agents: [ask] });
    needs.dismissNeeds(w);
    assert.equal(status.statusOf(w), "idle");
    assert.equal(status.isReady(w), false);
    needs.restoreNeeds(w);
  });

  it("counts Claude's idle nudge as finished", () => {
    const nudge = agent("needs_input", { kind: "claude", lastActivityAt: now() - 400, sinceEpoch: now() - 340 });
    const w = readyWs("nudge", { agents: [nudge] });
    assert.equal(needs.hasRealAsk(w), false);
    assert.equal(status.isReady(w), true);
    // The idle spell began when the turn ended, not when the nudge landed.
    assert.equal(status.statusLine(w), "Finished 6m");
  });

  it("is false with no workspace or no agent", () => {
    assert.equal(status.isReady(undefined), false);
    assert.equal(status.isReady(ws("w", { unread: 3 })), false);
  });
});

describe("a Ready card", () => {
  it("says when it finished, in the finished green", () => {
    const w = readyWs();
    assert.equal(status.statusLine(w), "Finished 6m");
    const info = status.statusInfo(w);
    assert.equal(info.label, "Finished");
    assert.equal(info.dot, "#788C5D");
    assert.equal(info.text, "#5E7A40");
    assert.equal(info.halo, "clear");
  });

  it("falls back to the last activity when nothing says when it finished", () => {
    const w = ws("w", { unread: 1, agents: [agent("idle", { lastActivityAt: now() - 180 })] });
    assert.equal(status.statusLine(w), "Finished 3m");
  });

  it("counts from the finish, not a later last activity, as the agents panel does (issue #98)", () => {
    const a = agent("idle", { sinceEpoch: now() - 360, lastActivityAt: now() - 180 });
    assert.equal(status.statusLine(readyWs("w", { agents: [a] })), "Finished 6m");
    assert.equal(status.statusLine(readyWs("w", { unread: 0, agents: [a] })), "Idle 6m");
  });

  it("dates an ended agent by its work, not by when its terminal closed", () => {
    const closed = agent("ended", { sinceEpoch: now() - 5, lastActivityAt: now() - 10_800 });
    assert.equal(status.statusLine(readyWs("w", { agents: [closed] })), "Finished 3h");
  });

  it("reports the agent the rest of the card reports, so its two ages agree", () => {
    const a = agent("idle", { sinceEpoch: now() - 900, lastActivityAt: now() - 60 });
    const b = agent("idle", { sinceEpoch: now() - 300, lastActivityAt: now() - 240 });
    const w = readyWs("w", { agents: [a, b] });
    assert.equal(status.readyAgent(w), a);
    assert.equal(status.statusLine(w), "Finished 15m");
    assert.equal(status.ageOf(w), "15m");
    // Once read, the card still reports the same agent and age.
    assert.equal(status.statusLine(readyWs("w", { unread: 0, agents: [a, b] })), "Idle 15m");
    assert.equal(status.readyAgent(ws("none")), null);
  });

  it("keeps the plain labels once read", () => {
    assert.equal(status.statusLine(readyWs("w", { unread: 0 })), "Idle 6m");
    assert.equal(status.statusLine(readyWs("w", { unread: 0, agents: [finished("ended")] })), "Finished 6m");
  });

  it("hides the unread badge behind the pill, and shows it otherwise", () => {
    assert.equal(status.badgeCount(readyWs()), 0);
    assert.equal(status.badgeCount(ws("w", { unread: 4, agents: [finished("working")] })), 4);
    assert.equal(status.badgeCount(undefined), 0);
  });
});

describe("a Ready card's PR words (issue #79)", () => {
  const withPr = (id: string) => readyWs(id, { branch: "feat" });

  it("leaves the PR out of the status line, since the chips row carries it", () => {
    assert.equal(status.statusLine(withPr("green")), "Finished 6m");
    assert.equal(status.statusLine(withPr("failing")), "Finished 6m");
  });

  it("keeps the PR on a compact card, in the chip's own words", () => {
    const text = (w: Workspace) => status.compactPrText(prs.prSummary(w));
    assert.equal(text(withPr("green")), "· #45 · ready");
    assert.equal(text(withPr("failing")), "· #46 · 1 failing");
    assert.equal(text(withPr("running")), "· #47 · running");
    assert.equal(text(withPr("draft")), "· #48 · draft");
    assert.equal(text(withPr("open")), "· #49");
    assert.equal(text(readyWs("m", { pr: { number: 50, status: "merged" } })), "· #50 · merged");
  });

  it("is empty without a PR", () => {
    assert.equal(status.compactPrText(prs.prSummary(readyWs("none"))), "");
    assert.equal(status.compactPrText(undefined), "");
    assert.equal(status.compactPrText({ text: "" }), "");
  });
});

describe("a Ready card's chips row", () => {
  it("has no row of its own: with no chip, a Ready card draws none", () => {
    r.data.groups = [group("g-main", "Main activity")];
    const w = readyWs("w", { group: "g-main" });
    r.data.workspaces = [w];
    assert.equal(status.isReady(w), true);
    assert.deepEqual(model.chipsFor(w, true), []);
    assert.equal(hasChipsRow(w, true), false);
  });

  it("still counts a chip as a chips row", () => {
    assert.equal(hasChipsRow(ws("b", { branch: "feat" }), true), true);
    assert.equal(hasChipsRow(ws("b", { branch: "feat" }), false), false);
  });
});
