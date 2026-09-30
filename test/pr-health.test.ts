// The PR rule the chips and the cockpit's lane moves share (pr-health.ts).

import assert from "node:assert/strict";
import { it } from "node:test";
import { healthOf, prSeenOf } from "../src/shared/pr-health.ts";

const pr: PullRequest = { number: 1, status: "open", mergeable: true };
const passed = [{ state: "pass" as const }];

it("reads merged, ready as the green chip, and anything else as other", () => {
  assert.equal(prSeenOf(undefined, []), "other", "no PR at all");
  assert.equal(prSeenOf({ status: "merged" }, []), "other", "a PR with no number shows no chip");
  assert.equal(prSeenOf({ ...pr, status: "merged" }, passed), "merged");
  assert.equal(prSeenOf(pr, passed), "ready");
  assert.equal(prSeenOf({ ...pr, draft: true }, passed), "other", "a draft is never ready");
  assert.equal(prSeenOf(pr, [{ state: "pending" }]), "other");
  assert.equal(prSeenOf(pr, []), "other", "no checks, so no ready it cannot see");
});

it("puts failing ahead of conflicts ahead of running", () => {
  const all = [{ state: "fail" as const }, { state: "pending" as const }];
  assert.equal(healthOf({ ...pr, conflicts: true }, all), "failing");
  assert.equal(healthOf({ ...pr, conflicts: true }, [{ state: "pending" }]), "conflicts");
  assert.equal(healthOf({ ...pr, status: "closed" }, all), "quiet");
});
