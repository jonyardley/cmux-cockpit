// The agents panel's tab choice read back from saved state (#403), and each tap sent as its own ui.tab entry.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { applySet, emptyState, type State } from "../scripts/state-config.ts";

(globalThis as Record<string, unknown>).__STATE__ = {
  dismissed: {},
  projectOverride: {},
  projects: {},
  prs: {},
  ownPrs: {},
  subagents: {},
  ui: { tab: { kept: "details", bad: "grid" } },
};

const { installRenderer } = await import("./support/renderer.ts");
const r = installRenderer();
const { ws } = await import("./support/fixtures.ts");
const d = await import("../src/agents/details.ts");

const select = (id: string): void => {
  r.data.workspaces = ["kept", "bad", "fresh"].map((w) => ws(w, { selected: w === id }));
};
const setLink = (ws: string, value: string | null): string =>
  `cmux-cockpit://set?key=${encodeURIComponent(`ui.tab.${ws}`)}${value === null ? "" : `&value=${encodeURIComponent(value)}`}`;

describe("the saved tab choice", () => {
  it("holds Details where it was saved, and shows Now for a bad or missing value", () => {
    select("kept");
    assert.equal(d.tabOf(), "details");
    select("bad");
    assert.equal(d.tabOf(), "now");
    select("fresh");
    assert.equal(d.tabOf(), "now");
  });

  it("sends only the tapped workspace's entry, and nothing for a tap that changes nothing", () => {
    r.opened.length = 0;
    select("fresh");
    d.chooseTab("now");
    d.chooseTab("details");
    assert.equal(d.tabOf(), "details", "the tap shows at once");
    d.chooseTab("details");
    select("kept");
    d.chooseTab("now");
    assert.deepEqual(r.opened, [setLink("fresh", '"details"'), setLink("kept", null)]);
  });

  it("leaves another workspace's saved choice alone when the baked copy is stale", () => {
    const file: State = { ...emptyState(), ui: { tab: { kept: "details", other: "details" } } };
    const after = r.opened.reduce<State>((state, link) => {
      const q = new URL(link).searchParams;
      const set = applySet(state, q.get("key") ?? "", q.get("value"));
      assert.ok(set.ok);
      return set.ok ? set.state : state;
    }, file);
    assert.deepEqual(after.ui.tab, { other: "details", fresh: "details" });
  });
});
