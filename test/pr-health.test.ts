// The PR rule every chip shares (pr-health.ts).

import assert from "node:assert/strict";
import { it } from "node:test";
import { healthOf } from "../src/shared/pr-health.ts";

const pr: PullRequest = { number: 1, status: "open", mergeable: true };
const passed = [{ state: "pass" as const }];

it("reads ready only as the green chip", () => {
  assert.equal(healthOf(pr, passed), "ready");
  assert.equal(healthOf({ ...pr, draft: true }, passed), "quiet", "a draft is never ready");
  assert.equal(healthOf(pr, [{ state: "pending" }]), "running");
  assert.equal(healthOf(pr, []), "quiet", "no checks, so no ready it cannot see");
  assert.equal(healthOf({ ...pr, mergeable: false }, passed), "quiet", "GitHub says it cannot merge");
});

it("puts failing ahead of conflicts ahead of running", () => {
  const all = [{ state: "fail" as const }, { state: "pending" as const }];
  assert.equal(healthOf({ ...pr, conflicts: true }, all), "failing");
  assert.equal(healthOf({ ...pr, conflicts: true }, [{ state: "pending" }]), "conflicts");
  assert.equal(healthOf({ ...pr, status: "closed" }, all), "quiet");
});
