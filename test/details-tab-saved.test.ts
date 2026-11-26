// The agents panel's tab choice read back from saved state after a rebuild
// (#403), and each tap sent out as ui.tab. __STATE__ is set before the
// renderer import, as in names-saved.test.ts, so a bad value can be planted.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

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
const setLink = (value: string | null): string =>
  `cmux-cockpit://set?key=ui.tab${value === null ? "" : `&value=${encodeURIComponent(value)}`}`;

describe("the saved tab choice", () => {
  it("holds Details where it was saved, and shows Now for a bad or missing value", () => {
    select("kept");
    assert.equal(d.tabOf(), "details");
    select("bad");
    assert.equal(d.tabOf(), "now");
    select("fresh");
    assert.equal(d.tabOf(), "now");
  });

  it("sends the whole map on each tap, and a delete once it is empty", () => {
    select("fresh");
    d.chooseTab("details");
    assert.equal(d.tabOf(), "details", "the tap shows at once");
    select("kept");
    d.chooseTab("now");
    select("fresh");
    d.chooseTab("now");
    assert.deepEqual(r.opened, [
      setLink('{"kept":"details","fresh":"details"}'),
      setLink('{"fresh":"details"}'),
      setLink(null),
    ]);
  });
});
