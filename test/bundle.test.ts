// Holds scripts/bundle.ts's UNREAD lists to the bundles themselves: each
// sidebar is built in memory as build.ts builds it, and every saved-state
// map its code reads must be one it is given.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { build } from "esbuild";
import { bundleOptions, ENTRIES, stateFor, UNREAD } from "../scripts/bundle.ts";
import { emptyState } from "../scripts/state-config.ts";

const baked = { projects: [], state: emptyState(), unreadable: false, urlToken: "", home: "" };

async function bundleText(entry: (typeof ENTRIES)[number]): Promise<string> {
  const result = await build(bundleOptions(entry, baked));
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
