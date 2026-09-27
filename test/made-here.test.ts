// The agents panel's Made here section (#52): pages and docs agents
// published, from the saved state the published hook writes. __STATE__ is
// set before the renderer import, as in published-saved.test.ts.

import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

const entry = (id: string, workspace: string, epoch: number, kind = "page") => ({
  url: "https://claude.ai/artifact/" + id,
  title: "Title " + id,
  kind,
  workspace,
  epoch,
});

const NOW = 1_000_000;

(globalThis as Record<string, unknown>).__STATE__ = {
  dismissed: {},
  projectOverride: {},
  projects: {},
  prs: {},
  ownPrs: {},
  subagents: {},
  published: Object.fromEntries(
    [
      entry("here-old", "sel", NOW - 500),
      entry("here-new", "sel", NOW - 100, "doc"),
      entry("o1", "other", NOW - 50),
      entry("o2", "other", NOW - 60),
      entry("o3", "gone", NOW - 70),
      entry("o4", "other", NOW - 80),
      // Past the seven days: dropped even though the file still holds it.
      entry("stale", "sel", NOW - 8 * 24 * 60 * 60),
    ].map((e) => [e.url, e]),
  ),
  ui: {},
};

const { installRenderer } = await import("./support/renderer.ts");
const r = installRenderer();
const { ws } = await import("./support/fixtures.ts");
const m = await import("../src/agents/model.ts");
const { T } = await import("../src/agents/theme.ts");

const ids = () => m.madeHere().map((e) => e.url.replace("https://claude.ai/artifact/", ""));

beforeEach(() => {
  r.data.epoch = NOW;
  r.data.workspaces = [
    ws("sel", { selected: true, directory: "/Users/jon/dev/app-one" }),
    ws("other", { directory: "/Users/jon/dev/app-two" }),
  ];
});

describe("madeHere", () => {
  it("puts the selected workspace's own first, newest first, then the latest three from others", () => {
    assert.deepEqual(ids(), ["here-new", "here-old", "o1", "o2", "o3"]);
  });

  it("marks only the final row last", () => {
    assert.deepEqual(
      m.madeHere().map((e) => e.last),
      [false, false, false, false, true],
    );
  });

  it("keys each row by its link, so a row keeps its one kind", () => {
    assert.equal(m.madeHere()[0]?.key, "m:https://claude.ai/artifact/here-new");
  });

  it("takes each row's project from the workspace it was made in, none once that workspace has gone", () => {
    const byId = new Map(m.madeHere().map((e) => [e.title, e.project.name]));
    assert.equal(byId.get("Title here-new"), "App One");
    assert.equal(byId.get("Title o1"), "App Two");
    assert.equal(byId.get("Title o3"), "");
  });

  it("lists everything as from elsewhere when no workspace is selected", () => {
    r.data.workspaces = [ws("other", { directory: "/Users/jon/dev/app-two" })];
    assert.deepEqual(ids(), ["o1", "o2", "o3"]);
    assert.ok(m.madeHere().every((e) => !e.here));
  });

  it("drops an entry once it passes seven days on the clock", () => {
    r.data.epoch = NOW - 500 + 7 * 24 * 60 * 60 + 1;
    assert.ok(!ids().includes("here-old"));
    assert.ok(ids().includes("here-new"));
  });
});

describe("Made here row helpers", () => {
  it("shows a window for a page and a sheet for a doc", () => {
    const [doc, page] = m.madeHere();
    assert.ok(doc && page);
    assert.equal(m.madeIcon(doc), "doc.text");
    assert.equal(m.madeIcon(page), "macwindow");
  });

  it("sets other workspaces' titles a step back", () => {
    const rows = m.madeHere();
    const here = rows.find((e) => e.here);
    const other = rows.find((e) => !e.here);
    assert.ok(here && other);
    assert.equal(m.madeTitleColor(here), T.text);
    assert.equal(m.madeTitleColor(other), T.secondary);
  });

  it("ages each row from when it was last published", () => {
    const [first] = m.madeHere();
    assert.ok(first);
    assert.equal(m.madeAge(first), "1m");
  });
});
