// Pages and docs agents published, from the saved state (#52). __STATE__
// is set before the import, as in prs-saved.test.ts.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

const entry = (id: string, epoch: number) => ({
  url: "https://claude.ai/artifact/" + id,
  title: "Title " + id,
  kind: "page",
  workspace: "w1",
  epoch,
});

(globalThis as Record<string, unknown>).__STATE__ = {
  dismissed: {},
  projectOverride: {},
  projects: {},
  prs: {},
  ownPrs: {},
  subagents: {},
  published: { a: entry("a", 100), b: entry("b", 300), c: entry("c", 200) },
  ui: {},
};

const { installRenderer } = await import("./support/renderer.ts");
installRenderer();
const { savedPublished } = await import("../src/shared/published.ts");

describe("savedPublished", () => {
  it("lists every saved page and doc, newest first", () => {
    assert.deepEqual(
      savedPublished().map((e) => e.title),
      ["Title b", "Title c", "Title a"],
    );
  });
});
