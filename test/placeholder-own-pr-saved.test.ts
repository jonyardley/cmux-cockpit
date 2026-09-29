// An own PR whose agent ran in a lane's placeholder workspace still shows,
// but names no chat: the placeholder is the lane's header, not a session.
// __STATE__ is set before the renderer import, since the saved PRs are read
// once at load.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

const url = "https://github.com/o/r/pull/7";
(globalThis as Record<string, unknown>).__STATE__ = {
  dismissed: {},
  projectOverride: {},
  projects: {},
  prs: {},
  ownPrs: { [url]: { number: 7, url, status: "open", branch: "feat", title: "Feature", repo: "o/r" } },
  prOrigins: { [url]: { url, number: 7, workspace: "anchor", session: "s", epoch: 1 } },
  ui: {},
};

const { installRenderer } = await import("./support/renderer.ts");
const r = installRenderer();
const { ws } = await import("./support/fixtures.ts");
const m = await import("../src/agents/model.ts");

describe("an own PR opened from a lane's placeholder", () => {
  it("shows once, with no session named", () => {
    r.data.workspaces = [ws("anchor", { title: "For review", pr: { url, number: 7, status: "open" } })];
    r.data.groups = [{ id: "g", name: "For review", anchorId: "anchor" }];
    const rows = m.prs();
    assert.deepEqual(
      rows.map((e) => [e.pr.number, e.session]),
      [[7, undefined]],
    );
  });
});
