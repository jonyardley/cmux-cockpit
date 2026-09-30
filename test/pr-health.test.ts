// The PR rule the chips and the cockpit's buttons share (pr-health.ts).

import assert from "node:assert/strict";
import { it } from "node:test";
import { healthOf, isMergedPr } from "../src/shared/pr-health.ts";

const pr: PullRequest = { number: 1, status: "open", mergeable: true };
const passed = [{ state: "pass" as const }];

it("reads ready only as the green chip", () => {
  assert.equal(healthOf(pr, passed), "ready");
  assert.equal(healthOf({ ...pr, draft: true }, passed), "quiet", "a draft is never ready");
  assert.equal(healthOf(pr, [{ state: "pending" }]), "running");
  assert.equal(healthOf(pr, []), "quiet", "no checks, so no ready it cannot see");
  assert.equal(healthOf({ ...pr, mergeable: false }, passed), "quiet", "GitHub says it cannot merge");
});

it("reads merged only on a PR with a number", () => {
  assert.equal(isMergedPr(undefined), false, "no PR at all");
  assert.equal(isMergedPr({ status: "merged" }), false, "a PR with no number shows no chip");
  assert.equal(isMergedPr({ ...pr, status: "merged" }), true);
  assert.equal(isMergedPr(pr), false);
});

it("puts failing ahead of conflicts ahead of running", () => {
  const all = [{ state: "fail" as const }, { state: "pending" as const }];
  assert.equal(healthOf({ ...pr, conflicts: true }, all), "failing");
  assert.equal(healthOf({ ...pr, conflicts: true }, [{ state: "pending" }]), "conflicts");
  assert.equal(healthOf({ ...pr, status: "closed" }, all), "quiet");
});
