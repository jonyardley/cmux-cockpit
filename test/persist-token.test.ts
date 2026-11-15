// persistSet with a token baked in, as build.ts bakes config/url-token
// into both bundles. In a file of its own, since __URL_TOKEN__ has to be
// set before the module is imported (persist.test.ts covers the bundle
// with none).

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { describe, it } from "node:test";
import { parseSetUrl, tokenMatches } from "../scripts/state-url.ts";
import { installRenderer } from "./support/renderer.ts";

// Made at run time, as build.ts makes the real one, so no token-shaped
// literal sits in the source for the secret scan to flag.
const TOKEN = randomBytes(32).toString("hex");
// globalThis has no index signature; the cast only lets the test stand in
// for esbuild's define, which persist.ts reads through a guarded typeof.
(globalThis as Record<string, unknown>).__URL_TOKEN__ = TOKEN;

const r = installRenderer();
const { persistSet } = await import("../src/shared/persist.ts");

describe("persistSet with a token", () => {
  it("sends the token last, after the value", () => {
    persistSet("dismissed.w1", { a1: 500 });
    assert.deepEqual(r.opened, [
      `cmux-cockpit://set?key=dismissed.w1&value=${encodeURIComponent('{"a1":500}')}&token=${TOKEN}`,
    ]);
  });

  it("sends it on a delete too, and the handler's check accepts it", () => {
    r.opened.length = 0;
    persistSet("projectOverride.w1", null);
    const parsed = parseSetUrl(r.opened[0] ?? "");
    assert.equal(parsed.ok, true);
    assert.equal(parsed.ok && tokenMatches(parsed.token, TOKEN), true);
  });
});
