// The PR list's lane placeholders in a bundle built without __LANES__:
// today's four names, matched by title alone.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BUILT_IN_LANE_NAMES as BUILD_NAMES } from "../scripts/lanes-config.ts";
import { installRenderer } from "./support/renderer.ts";

installRenderer();
const { agent, ws } = await import("./support/fixtures.ts");
const { BUILT_IN_LANE_NAMES, isLanePlaceholder } = await import("../src/agents/pr-list.ts");

describe("isLanePlaceholder", () => {
  it("falls back to the same four names the build uses", () => {
    assert.deepEqual(BUILT_IN_LANE_NAMES, BUILD_NAMES);
  });

  it("takes every workspace titled after a lane, ignoring case and spaces, busy or not", () => {
    const titled = [
      ws("idle", { title: " for REVIEW ", agents: [agent("idle")] }),
      ws("none", { title: "Parked" }),
      ws("busy", { title: "Background", agents: [agent("working")] }),
      ws("asking", { title: "Main activity", agents: [agent("needs_input")] }),
    ];
    for (const w of titled) assert.equal(isLanePlaceholder(w), true, w.id);
  });

  it("keeps a chat with any other title, or none", () => {
    for (const w of [ws("chat", { title: "Some chat" }), ws("mine", { title: "my group" }), ws("bare")])
      assert.equal(isLanePlaceholder(w), false, w.id);
  });
});
