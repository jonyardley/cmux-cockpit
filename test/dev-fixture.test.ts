// native/mac/dev-fixture.py, which moves a golden scene's times to now for
// the dev sidebar (issue #394). The core compares times with its clock and
// with each other, so every time in a scene must move by one step or a card
// reads 20759d, or an ask, a move or a dismissal stops matching its
// session. The golden README fixes every scene's clock at 1000000 with each
// time a whole number of seconds before it, so any number within a day of
// the clock is a time, and every other number must stay as it was.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

const ROOT = join(import.meta.dirname, "..");
const SCRIPT = join(ROOT, "native", "mac", "dev-fixture.py");
const GOLDEN = join(ROOT, "test", "golden");
const DAY = 24 * 60 * 60;
const RECORD_TEXT = /^ostinato\.records\.[^.]+\.text$/;

const scenes = readdirSync(GOLDEN)
  .filter((f) => f.endsWith(".input.json"))
  .map((f) => f.slice(0, -".input.json".length));

const out = mkdtempSync(join(tmpdir(), "dev-fixture-"));
after(() => rmSync(out, { recursive: true, force: true }));

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Mismatch = { path: string; was: Json; now: Json };

const isObject = (v: Json): v is { [key: string]: Json } => typeof v === "object" && v !== null && !Array.isArray(v);

const lineTime = (line: string): number | undefined => {
  try {
    const row: Json = JSON.parse(line);
    return isObject(row) && typeof row.at === "string" ? Date.parse(row.at) / 1000 : undefined;
  } catch {
    return undefined;
  }
};

// A record line keeps everything but its time.
const withoutTime = (line: string): string => {
  try {
    const row: Json = JSON.parse(line);
    if (isObject(row)) delete row.at;
    return JSON.stringify(row);
  } catch {
    return line;
  }
};

const recordMismatches = (path: string, was: string, now: string, step: number): Mismatch[] => {
  const before = was.split("\n");
  const after = now.split("\n");
  if (before.length !== after.length) return [{ path, was, now }];
  return before.flatMap((line, i) => {
    const t = lineTime(line);
    const moved = t === undefined || lineTime(after[i] ?? "") === t + step;
    const same = withoutTime(line) === withoutTime(after[i] ?? "");
    return moved && same ? [] : [{ path: `${path}[line ${i + 1}]`, was: line, now: after[i] ?? "" }];
  });
};

// Every place `now` differs from `was` other than each time moved by `step`.
const mismatches = (was: Json, now: Json, clock: number, step: number, path: string): Mismatch[] => {
  if (typeof was === "number") {
    const isTime = Math.abs(was - clock) <= DAY;
    return now === (isTime ? was + step : was) ? [] : [{ path, was, now }];
  }
  if (Array.isArray(was) && Array.isArray(now) && was.length === now.length) {
    return was.flatMap((v, i) => mismatches(v, now[i] ?? null, clock, step, `${path}[${i}]`));
  }
  if (isObject(was) && isObject(now)) {
    const keys = new Set([...Object.keys(was), ...Object.keys(now)]);
    return [...keys].flatMap((k) => {
      const inner = `${path}.${k}`;
      const a = was[k] ?? null;
      const b = now[k] ?? null;
      // An Ostinato record's text is JSON lines, each with its own time.
      if (RECORD_TEXT.test(inner) && typeof a === "string" && typeof b === "string") {
        return recordMismatches(inner, a, b, step);
      }
      return mismatches(a, b, clock, step, inner);
    });
  }
  return was === now ? [] : [{ path, was, now }];
};

const run = (scene: string): { input: { [key: string]: Json }; written: { [key: string]: Json } } => {
  const dest = join(out, `${scene}.json`);
  const result = spawnSync("python3", [SCRIPT, join(GOLDEN, `${scene}.input.json`), "/Users/jon", dest], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  const input: Json = JSON.parse(readFileSync(join(GOLDEN, `${scene}.input.json`), "utf8"));
  const written: Json = JSON.parse(readFileSync(dest, "utf8"));
  assert.ok(isObject(input) && isObject(written));
  return { input, written };
};

describe("dev-fixture.py", () => {
  it("finds the golden scenes", () => {
    assert.ok(scenes.includes("lanes") && scenes.includes("ostinato"), scenes.join(", "));
  });

  for (const scene of scenes) {
    it(`moves every time in ${scene} to now by one whole step, and nothing else`, () => {
      const { input, written } = run(scene);
      const data = input.data ?? null;
      const moved = written.data ?? null;
      assert.ok(isObject(data) && isObject(moved));
      assert.ok(typeof data.epoch === "number" && typeof moved.epoch === "number");
      const step = moved.epoch - data.epoch;
      assert.ok(Number.isInteger(step), `step ${step}`);
      assert.ok(Math.abs(moved.epoch - Date.now() / 1000) < 60, `clock ${moved.epoch}`);
      for (const key of ["projects", "state", "ostinato", "data"] as const) {
        assert.deepEqual(mismatches(input[key] ?? null, written[key] ?? null, data.epoch, step, key), []);
      }
    });
  }
});
