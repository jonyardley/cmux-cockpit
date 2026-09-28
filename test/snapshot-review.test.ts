// Scene: the For review lane with a card for each merge verdict, and its
// header's "N ready to merge". Fixture data only; see test/support/snapshot.ts.

import { it } from "node:test";
import type { SavedPr } from "../scripts/state-config.ts";
import { seed, snapshotScene } from "./support/snapshot.ts";

const pass = [{ name: "build", state: "pass" as const }];
const pr = (number: number, extra: Partial<SavedPr> = {}): SavedPr => ({
  url: `https://github.com/o/r/pull/${number}`,
  number,
  status: "open",
  branch: `feat-${number}`,
  title: `Feature ${number}`,
  checks: pass,
  ...extra,
});

const PRS: Record<string, SavedPr> = {
  ready: pr(1, { mergeable: true }),
  draft: pr(2, { mergeable: true, draft: true }),
  failing: pr(3, { mergeable: true, checks: [{ name: "build", state: "fail" }] }),
  running: pr(4, { checks: [{ name: "build", state: "pending" }] }),
  conflicts: pr(5, { conflicts: true }),
  blocked: pr(6),
  merged: pr(7, { status: "merged" }),
  closed: pr(8, { status: "closed" }),
};
const r = seed({ state: { prs: PRS } });
const { group, ws } = await import("./support/fixtures.ts");
await import("../src/cockpit/index.ts");
const { C } = await import("../src/cockpit/theme.ts");

it("for review: merge verdicts", () => {
  r.data.groups = [group("g-review", "For review", { anchorId: "anchor-review" })];
  r.data.workspaces = [
    ws("anchor-review", { title: "For review", group: "g-review" }),
    ...Object.entries(PRS).map(([id, p]) => ws(id, { title: `${id} card`, group: "g-review", branch: p.branch })),
  ];
  snapshotScene("review-verdicts", r, C);
});
