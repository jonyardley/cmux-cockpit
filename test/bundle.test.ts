// Holds scripts/bundle.ts's UNREAD lists to the bundles themselves: each
// sidebar is built in memory as build.ts builds it, and every saved-state
// map its code reads must be one it is given.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { build } from "esbuild";
import { type Baked, bundleOptions, cockpitPr, ENTRIES, stateFor, UNREAD } from "../scripts/bundle.ts";
import { emptyState, type SavedCheck, type SavedPr } from "../scripts/state-config.ts";

const baked: Baked = { projects: [], state: emptyState(), unreadable: false, urlToken: "", home: "" };

async function bundleText(entry: (typeof ENTRIES)[number], with_: Baked = baked): Promise<string> {
  const result = await build(bundleOptions(entry, with_));
  return result.outputFiles.map((f) => f.text).join("\n");
}

describe("each sidebar's saved state", () => {
  for (const entry of ENTRIES) {
    it(`gives ${entry} every map its bundle reads`, async () => {
      const text = await bundleText(entry);
      const read = new Set([...text.matchAll(/SAVED_STATE\d*\.(\w+)/g)].map((m) => m[1]));
      assert.ok(read.size > 0, "the bundle reads saved state by name");
      for (const k of UNREAD[entry]) assert.ok(!read.has(k), `${entry} reads ${k}, which UNREAD leaves out`);
    });

    it(`reads ${entry}'s saved state only by name, so the scan sees every read`, async () => {
      const whole = [...(await bundleText(entry)).matchAll(/SAVED_STATE\d*(?![\w.])(?!\s*=[^=])/g)];
      assert.deepEqual(
        whole.map((m) => m[0]),
        [],
      );
    });
  }

  it("leaves out only the listed maps", () => {
    const state = emptyState();
    const agents = stateFor("agents", state);
    assert.ok(!("ui" in agents) && !("mergeKept" in agents) && !("projects" in agents));
    assert.ok("prs" in agents && "poll" in stateFor("agents", { ...state, poll: { okEpoch: 1 } }));
    const cockpit = stateFor("cockpit", { ...state, poll: { okEpoch: 1 } });
    assert.ok(!("poll" in cockpit) && !("published" in cockpit) && "ui" in cockpit);
  });
});

// One draft PR on 4 Oct: ten pushes in seventy minutes, and every check
// passing between them rewrote both sidebars, though the cockpit's chip
// said "draft · running" throughout.
describe("a poll that moves only what the agents panel shows", () => {
  const pr = (checks: SavedCheck[], extra: Partial<SavedPr> = {}): SavedPr => ({
    number: 197,
    url: "https://github.com/o/r/pull/197",
    status: "open",
    branch: "ci/testflight",
    draft: true,
    title: "ci: upload to TestFlight",
    checks,
    ...extra,
  });
  const at = (p: SavedPr): Baked => ({ ...baked, state: { ...emptyState(), prs: { ws1: p } } });
  const both = async (p: SavedPr) => ({
    agents: await bundleText("agents", at(p)),
    cockpit: await bundleText("cockpit", at(p)),
  });

  const pushed = pr([
    { name: "Lint, Build & Test", state: "pending" },
    { name: "Site templates in sync", state: "pending" },
    { name: "gitleaks", state: "pending" },
  ]);
  const gitleaksPassed = pr([
    { name: "Lint, Build & Test", state: "pending" },
    { name: "Site templates in sync", state: "pending" },
    { name: "gitleaks", state: "pass" },
  ]);
  const testflightJoined = pr([
    { name: "Archive & upload to TestFlight", state: "pending" },
    { name: "Lint, Build & Test", state: "pending" },
    { name: "Site templates in sync", state: "pass" },
    { name: "gitleaks", state: "pass" },
  ]);
  const testflightFailed = pr([
    { name: "Archive & upload to TestFlight", state: "fail" },
    { name: "Lint, Build & Test", state: "pending" },
    { name: "Site templates in sync", state: "pass" },
    { name: "gitleaks", state: "pass" },
  ]);

  it("leaves the cockpit's file as it was while its chip says the same, and rewrites the agents panel's", async () => {
    const steps = await Promise.all([pushed, gitleaksPassed, testflightJoined].map(both));
    for (const [i, step] of steps.entries()) {
      if (i === 0) continue;
      const before = steps[i - 1];
      assert.ok(before);
      assert.equal(step.cockpit, before.cockpit, `step ${i} redrew the cockpit`);
      assert.notEqual(step.agents, before.agents, `step ${i} left the agents panel's check list stale`);
    }
  });

  it("rewrites the cockpit once a check fails, since its chip then says so", async () => {
    const [running, failing] = await Promise.all([testflightJoined, testflightFailed].map(both));
    assert.ok(running && failing);
    assert.notEqual(failing.cockpit, running.cockpit);
  });

  it("leaves the cockpit alone when a ready PR's merge verdict flips while a check runs", async () => {
    const outOfDraft = (checks: SavedCheck[]): SavedPr => {
      const { draft: _, ...p } = pr(checks);
      return p;
    };
    const ready = { ...outOfDraft([{ name: "gitleaks", state: "pass" }]), mergeable: true as const };
    const rerun = outOfDraft([
      { name: "gitleaks", state: "pass" },
      { name: "Lint, Build & Test", state: "pending" },
    ]);
    const [verdict, noVerdict] = await Promise.all([{ ...rerun, mergeable: true as const }, rerun].map(both));
    const first = await both(ready);
    assert.ok(verdict && noVerdict);
    assert.notEqual(verdict.cockpit, first.cockpit, "a ready chip turning running redraws the cockpit");
    assert.equal(noVerdict.cockpit, verdict.cockpit);
    assert.notEqual(noVerdict.agents, verdict.agents);
  });

  it("leaves the cockpit alone when a draft's merge verdict comes or goes", async () => {
    const [without, withVerdict] = await Promise.all([pushed, { ...pushed, mergeable: true as const }].map(both));
    assert.ok(without && withVerdict);
    assert.equal(withVerdict.cockpit, without.cockpit);
  });
});

describe("cockpitPr", () => {
  const open: SavedPr = { number: 1, url: "u", status: "open", branch: "b" };
  const check = (name: string, state: SavedCheck["state"]): SavedCheck => ({ name, state });

  it("keeps one nameless check per failure, else one running, else one passed", () => {
    const failing = [check("a", "fail"), check("b", "fail"), check("c", "pending"), check("d", "pass")];
    assert.deepEqual(cockpitPr({ ...open, checks: failing }).checks, [check("", "fail"), check("", "fail")]);
    const running = [check("c", "pending"), check("d", "pending"), check("e", "pass")];
    assert.deepEqual(cockpitPr({ ...open, checks: running }).checks, [check("", "pending")]);
    const passed = [check("d", "pass"), check("e", "pass")];
    assert.deepEqual(cockpitPr({ ...open, mergeable: true, checks: passed }).checks, [check("", "pass")]);
  });

  it("keeps no checks for a quiet PR, since none would change its chip", () => {
    assert.ok(!("checks" in cockpitPr({ ...open, checks: [check("d", "pass")] })));
    assert.ok(!("checks" in cockpitPr({ ...open, draft: true, mergeable: true, checks: [check("d", "pass")] })));
  });

  it("leaves out checks it has none of, and every check of a PR that is not open", () => {
    assert.ok(!("checks" in cockpitPr(open)));
    assert.ok(!("checks" in cockpitPr({ ...open, status: "merged", checks: [check("a", "fail")] })));
  });

  it("keeps the merge verdict only while the chip says ready, and conflicts only while it says conflicts", () => {
    const passed = [check("d", "pass")];
    assert.equal(cockpitPr({ ...open, mergeable: true, checks: passed }).mergeable, true);
    assert.ok(!("mergeable" in cockpitPr({ ...open, mergeable: true })));
    assert.ok(!("mergeable" in cockpitPr({ ...open, mergeable: true, checks: [check("c", "pending")] })));
    assert.ok(!("mergeable" in cockpitPr({ ...open, mergeable: true, draft: true, checks: passed })));
    assert.ok(!("mergeable" in cockpitPr({ ...open, mergeable: true, status: "closed", checks: passed })));
    assert.equal(cockpitPr({ ...open, conflicts: true, draft: true }).conflicts, true);
    assert.ok(!("conflicts" in cockpitPr({ ...open, conflicts: true, checks: [check("a", "fail")] })));
    assert.ok(!("conflicts" in cockpitPr({ ...open, conflicts: true, status: "merged" })));
  });

  it("keeps only the number, link, status, branch and title of a PR that is not open", () => {
    const whole: SavedPr = { ...open, title: "t", draft: true, conflicts: true, additions: 3, deletions: 1 };
    for (const status of ["merged", "closed"] as const)
      assert.deepEqual(cockpitPr({ ...whole, status }), { number: 1, url: "u", status, branch: "b", title: "t" });
  });

  it("shows every PR exactly as the whole PR would", async () => {
    // A test process never bakes __STATE__; prs.ts reads it on import.
    (globalThis as Record<string, unknown>).__STATE__ = emptyState();
    const { summaryOf } = await import("../src/shared/prs.ts");
    const states: SavedCheck["state"][] = ["fail", "pending", "pass"];
    const checkLists: SavedCheck[][] = [
      [],
      ...states.map((s) => [check("a", s)]),
      ...states.flatMap((s) => states.map((t) => [check("a", s), check("b", t)])),
      [check("a", "fail"), check("b", "fail"), check("c", "pending"), check("d", "pass")],
    ];
    const flags: Partial<SavedPr>[] = [{}, { draft: true }, { mergeable: true }, { conflicts: true }];
    const combos = flags.flatMap((a) => flags.map((b) => ({ ...a, ...b })));
    for (const status of ["open", "merged", "closed"] as const)
      for (const extra of combos)
        for (const checks of checkLists) {
          const pr: SavedPr = { ...open, status, title: "t", additions: 4, deletions: 2, ...extra, checks };
          const cut = cockpitPr(pr);
          const label = JSON.stringify(pr);
          assert.deepEqual(summaryOf(cut, cut.checks ?? []), summaryOf(pr, pr.checks ?? []), label);
        }
  });

  it("is what stateFor bakes into the cockpit, and the agents panel keeps the whole PR", () => {
    const pr: SavedPr = { ...open, draft: true, mergeable: true, checks: [check("lint", "pass")] };
    const state = { ...emptyState(), prs: { ws1: pr } };
    assert.deepEqual(stateFor("cockpit", state).prs, { ws1: cockpitPr(pr) });
    assert.deepEqual(stateFor("agents", state).prs, { ws1: pr });
  });
});
