// The cockpit is baked with each PR cut to what it shows (scripts/bundle.ts's
// cockpitPr), so a check passing beside a running one never rewrites its
// file. This draws the review-verdicts scene from PRs whose checks differ
// from that scene's in every way the cut drops (other names, more checks
// passed beside a running or failing one, a draft's merge verdict, a merged
// PR's checks), cut as the build cuts them, and holds it to the scene's
// saved snapshot: what the cut drops never shows.

import { it } from "node:test";
import { stateFor } from "../scripts/bundle.ts";
import { emptyState, type SavedCheck, type SavedPr } from "../scripts/state-config.ts";
import { seed, snapshotScene } from "./support/snapshot.ts";

const check = (name: string, state: SavedCheck["state"]): SavedCheck => ({ name, state });
const passed = [check("build", "pass"), check("lint", "pass"), check("gitleaks", "pass")];
const pr = (number: number, extra: Partial<SavedPr> = {}): SavedPr => ({
  url: `https://github.com/o/r/pull/${number}`,
  number,
  status: "open",
  branch: `feat-${number}`,
  title: `Feature ${number}`,
  checks: passed,
  ...extra,
});

// The same verdicts as test/snapshot-review.test.ts's PRS, by other checks.
const PRS: Record<string, SavedPr> = {
  ready: pr(1, { mergeable: true, additions: 120, deletions: 8 }),
  draft: pr(2, { mergeable: true, draft: true, additions: 1234, deletions: 56 }),
  failing: pr(3, { mergeable: true, checks: [check("e2e", "pending"), check("test", "fail"), ...passed] }),
  running: pr(4, { checks: [check("build", "pending"), check("e2e", "pending"), check("lint", "pass")] }),
  conflicts: pr(5, { conflicts: true }),
  blocked: pr(6, { checks: [check("docs", "pass")] }),
  merged: pr(7, { status: "merged", mergeable: true, checks: [check("build", "fail")] }),
  closed: pr(8, { status: "closed", checks: [check("build", "pending")] }),
  waiting: pr(9, { mergeable: true }),
};

const r = seed({ state: { prs: stateFor("cockpit", { ...emptyState(), prs: PRS }).prs ?? {} } });
const { group, ws } = await import("./support/fixtures.ts");
await import("../src/cockpit/index.ts");
const { C } = await import("../src/cockpit/theme.ts");

it("draws the review verdicts from the cut PRs exactly as from the whole ones", () => {
  r.data.groups = [
    group("g-main", "Main activity", { anchorId: "anchor-main" }),
    group("g-review", "For review", { anchorId: "anchor-review" }),
  ];
  const { waiting: _, ...verdicts } = PRS;
  r.data.workspaces = [
    ws("anchor-main", { title: "Main activity", group: "g-main" }),
    ws("waiting", { title: "waiting card", group: "g-main", branch: "feat-9" }),
    ws("anchor-review", { title: "For review", group: "g-review" }),
    ...Object.entries(verdicts).map(([id, p]) => ws(id, { title: `${id} card`, group: "g-review", branch: p.branch })),
  ];
  snapshotScene("review-verdicts", r, C, "cockpit");
});
