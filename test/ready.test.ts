// The Ready state on cockpit cards (issue #53): an agent that finished while
// Jon was elsewhere, with output he has not read. __STATE__ is set before the
// renderer import, as in prs-saved.test.ts, so a saved PR can be green.

import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { emptyState } from "../scripts/state-config.ts";

const saved = { url: "https://github.com/o/r/pull/45", status: "open", branch: "feat" } as const;
const pass = [{ name: "build", state: "pass" }] as const;
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
const model = await import("../src/cockpit/model.ts");
const needs = await import("../src/shared/needs.ts");

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
    assert.equal(status.statusLine(w), "Finished 6m ago");
  });

  it("is false with no workspace or no agent", () => {
    assert.equal(status.isReady(undefined), false);
    assert.equal(status.isReady(ws("w", { unread: 3 })), false);
  });
});

describe("a Ready card", () => {
  it("says when it finished, in the done green", () => {
    const w = readyWs();
    assert.equal(status.statusLine(w), "Finished 6m ago");
    const info = status.statusInfo(w);
    assert.equal(info.label, "Finished");
    assert.equal(info.dot, "#788C5D");
    assert.equal(info.text, "#5E7A40");
    assert.equal(info.halo, "clear");
  });

  it("leaves the time off when nothing says when the status began", () => {
    assert.equal(status.statusLine(ws("w", { unread: 1, agents: [agent("idle", { lastActivityAt: 5 })] })), "Finished");
  });

  it("keeps the plain labels once read", () => {
    assert.equal(status.statusLine(readyWs("w", { unread: 0 })), "Idle 6m");
    assert.equal(status.statusLine(readyWs("w", { unread: 0, agents: [finished("ended")] })), "Done 6m");
  });

  it("hides the unread badge behind the pill, and shows it otherwise", () => {
    assert.equal(status.badgeCount(readyWs()), 0);
    assert.equal(status.badgeCount(ws("w", { unread: 4, agents: [finished("working")] })), 4);
    assert.equal(status.badgeCount(undefined), 0);
  });
});

describe("readyPrText", () => {
  const withPr = (id: string) => readyWs(id, { branch: "feat" });

  it("says a green PR is green", () => {
    assert.equal(status.readyPrText(withPr("green")), "· PR #45 is green");
  });

  it("says what else a PR is doing", () => {
    assert.equal(status.readyPrText(withPr("failing")), "· PR #46 is failing");
    assert.equal(status.readyPrText(withPr("running")), "· PR #47 checks running");
    assert.equal(status.readyPrText(withPr("draft")), "· PR #48 is a draft");
    assert.equal(status.readyPrText(withPr("open")), "· PR #49 is open");
    assert.equal(status.readyPrText(readyWs("m", { pr: { number: 50, status: "merged" } })), "· PR #50 merged");
  });

  it("is empty without a PR or off a Ready card", () => {
    assert.equal(status.readyPrText(readyWs("none")), "");
    assert.equal(status.readyPrText(ws("green", { branch: "feat", unread: 0, agents: [finished("idle")] })), "");
  });
});

describe("To review", () => {
  const lanes = () => [group("g-review", "For review"), group("g-main", "Main activity")];

  it("offers To review on a Ready card outside For review, and files it there", () => {
    r.data.groups = lanes();
    const w = readyWs("w", { group: "g-main" });
    r.data.workspaces = [w];
    assert.equal(model.canFileForReview(w), true);
    assert.equal(model.hasChipsRow(w, true), true);
    model.fileForReview(w);
    assert.deepEqual(r.calls.at(-1), {
      method: "workspace.group.add",
      params: { group_id: "g-review", workspace_id: "w" },
    });
    // The move shows at once, so the action goes with it.
    assert.equal(model.canFileForReview(w), false);
  });

  it("is not offered in For review, off a Ready card, or with no workspace", () => {
    r.data.groups = lanes();
    const inReview = readyWs("r", { group: "g-review" });
    const read = readyWs("x", { unread: 0 });
    r.data.workspaces = [inReview, read];
    assert.equal(model.canFileForReview(inReview), false);
    assert.equal(model.canFileForReview(read), false);
    assert.equal(model.hasChipsRow(read, true), false);
    assert.equal(model.canFileForReview(undefined), false);
  });

  it("is not offered on a lane's generated anchor", () => {
    r.data.groups = [group("g-main", "Main activity", { anchorId: "anchor" })];
    const anchor = readyWs("anchor", { title: "Main activity", group: "g-main" });
    r.data.workspaces = [anchor];
    assert.equal(status.isReady(anchor), true);
    assert.equal(model.canFileForReview(anchor), false);
  });

  it("still counts a chip as a chips row", () => {
    assert.equal(model.hasChipsRow(ws("b", { branch: "feat" }), true), true);
    assert.equal(model.hasChipsRow(ws("b", { branch: "feat" }), false), false);
  });
});
