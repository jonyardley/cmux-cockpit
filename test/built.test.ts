// Runs the built sidebars/*.js the way cmux does, one flat script with the
// renderer's globals, and renders each root against busy fixture data. This
// catches what the type checker cannot: a bundle that imports, exports, or
// throws while building its views.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { agent, group, ws } from "./support/fixtures.ts";
import { createRenderer, runBuilt } from "./support/renderer.ts";

const SIDEBARS = ["sidebars/agents.js", "sidebars/cockpit.js"];

function busyRenderer() {
  const r = createRenderer();
  r.data.groups = [
    group("g-main", "Main activity", { anchorId: "anchor" }),
    group("g-proj", "app-one", { anchorId: "x" }),
  ];
  r.data.workspaces = [
    ws("anchor", { title: "Main activity", group: "g-main" }),
    ws("x", {
      title: "✳ Busy",
      group: "g-main",
      selected: true,
      directory: "/Users/coder/dev/app-one",
      unread: 3,
      branch: "feat",
      dirty: true,
      latestMessage: "Done <x>markup</x> [Image #1]",
      progress: { value: 0.4, label: "Building" },
      ports: [3000, 5173],
      pr: { url: "https://github.com/o/r/pull/1", number: 1, status: "open", label: "PR" },
      agents: [agent("needs_input", { sinceEpoch: 1 }), agent("working", { surfaceId: "s1" })],
    }),
    ...Array.from({ length: 6 }, (_, i) =>
      ws("i" + i, { agents: [agent("idle", { lastActivityAt: i })], prs: [{ url: "u/" + i, status: "merged" }] }),
    ),
    ws("asks", { title: "✳ Asks", agents: [agent("needs_input", { sinceEpoch: 5, surfaceId: "s2" })] }),
    ws("runs", { agents: [agent("working", { sinceEpoch: 9 })] }),
    ws("bare"),
  ];
  return r;
}

describe("built sidebars", () => {
  for (const file of SIDEBARS) {
    it(`${file} is a flat script with no import or export`, () => {
      const src = readFileSync(file, "utf8");
      assert.doesNotMatch(src, /^\s*(import|export)\b/m);
    });

    it(`${file} registers one root that renders busy and empty data`, () => {
      const r = busyRenderer();
      runBuilt(file, r);
      assert.equal(r.roots.length, 1);
      const root = r.roots[0];
      assert.ok(root);
      root();
      r.data.workspaces = [];
      r.data.groups = [];
      root();
      // Rendering alone must never dispatch or open anything.
      assert.deepEqual(r.calls, []);
      assert.deepEqual(r.opened, []);
    });
  }
});
