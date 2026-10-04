// Golden JSON for the native core (npm run golden re-records it).
//
// For each cockpit scene in scenes.ts, writes what the scene starts from
// (test/golden/<scene>.input.json: the cmux data, the saved state and the
// project table) and what the TypeScript model computes from it
// (test/golden/<scene>.json: lanes and placement, Needs you, lane entries,
// Projects entries and Next). Plain values only, no view tree; workspaces
// are named by id. Keys are sorted at every level and the clock is the
// scene's fixed EPOCH, so a file changes only when the model's answer does.
// Biome lays the text out, as it does every JSON file here. Any drift
// fails the test with a diff, as the text snapshots do.
// test/golden/README.md documents every field: it is the contract the Rust
// side reads.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { Renderer } from "./renderer.ts";
import { lineDiff } from "./snapshot.ts";

const DIR = "test/golden";
const UPDATE = process.env.UPDATE_GOLDEN === "1";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** A value with every object's keys sorted, arrays left in their order. */
function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v === null || typeof v !== "object") return v;
  const entries = Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return Object.fromEntries(entries.map(([k, x]) => [k, sortKeys(x)]));
}

/**
 * Stable JSON text: sorted keys, laid out by Biome as npm run lint wants
 * every JSON file in the repo, so the recorded file and the one built in
 * memory compare as text. `file` is only the path Biome formats it as.
 */
export function stableJson(v: unknown, file: string): string {
  const raw = JSON.stringify(sortKeys(v));
  const out = spawnSync("node_modules/.bin/biome", ["format", `--stdin-file-path=${file}`], {
    input: raw,
    encoding: "utf8",
  });
  assert.equal(out.status, 0, `biome could not format ${file}: ${out.stderr}`);
  return out.stdout;
}

// Read once per call, after the sidebar loaded: a static import here would
// load the model before the test seeds the saved state it reads at import.
async function model() {
  const [lanes, m, entries, strip, next, byProject, status, state] = await Promise.all([
    import("../../src/cockpit/lanes.ts"),
    import("../../src/cockpit/model.ts"),
    import("../../src/cockpit/lane-entries.ts"),
    import("../../src/cockpit/strip.ts"),
    import("../../src/cockpit/next.ts"),
    import("../../src/cockpit/by-project.ts"),
    import("../../src/cockpit/status.ts"),
    import("../../src/cockpit/state.ts"),
  ]);
  return { ...lanes, ...m, ...entries, ...strip, ...next, ...byProject, ...status, ...state };
}

type Model = Awaited<ReturnType<typeof model>>;

const ids = (ws: readonly Workspace[]): string[] => ws.map((w) => w.id);

/** Each workspace's lane, size, status and project, keyed by id. */
function placement(m: Model): Record<string, Json> {
  const cardIds = new Set(ids(m.cards()));
  return Object.fromEntries(
    m.allWorkspaces().map((w) => [
      w.id,
      {
        actualLane: m.actualLaneOf(w),
        card: cardIds.has(w.id),
        density: m.cardDensity(w),
        lane: m.laneOf(w),
        project: m.projectKey(w),
        stateRank: m.stateRank(w),
        status: m.statusOf(w),
      },
    ]),
  );
}

/** Each lane header: folded or not, the cards it counts, its merge line. */
function laneHeaders(m: Model): Record<string, Json> {
  return Object.fromEntries(
    m.LANES.map((lane) => [
      lane.key,
      {
        collapsed: m.isCollapsed(lane),
        mergeReady: m.mergeReadyText(lane.key),
        workspaces: ids(m.laneWorkspaces(lane.key)),
      },
    ]),
  );
}

function needs(m: Model): Json {
  return {
    inStrip: [...m.inStrip()],
    late: m.needsWaitLate(),
    list: ids(m.needsList()),
    more: m.needsMore(),
    shown: ids(m.needsShown()),
    waitText: m.needsWaitText(),
  };
}

function nextOut(m: Model): Json {
  const step = m.nextStep();
  return {
    queue: ids(m.nextQueue()),
    step: step ? { position: step.position, target: step.target.id, total: step.total } : null,
  };
}

/** What the model computes for the scene now on the fake renderer. */
async function outputs(): Promise<Json> {
  const m = await model();
  return {
    laneEntries: m.flatEntries(),
    laneHeaders: laneHeaders(m),
    mode: m.mode(),
    needs: needs(m),
    next: nextOut(m),
    placement: placement(m),
    projectEntries: m.projectEntries(),
    quietProjects: m.quietProjects(),
  };
}

/** What the scene starts from: the cmux data, and what the build bakes in. */
function inputs(r: Renderer): unknown {
  const g = globalThis as Record<string, unknown>;
  return { data: r.data, projects: g.__PROJECTS__, state: g.__STATE__ };
}

function match(file: string, text: string): void {
  if (UPDATE) {
    mkdirSync(DIR, { recursive: true });
    writeFileSync(file, text);
    return;
  }
  const saved = existsSync(file) ? readFileSync(file, "utf8") : undefined;
  assert.ok(saved !== undefined, `${file} is missing: run npm run golden to record it`);
  if (text !== saved)
    assert.fail(`${file} is stale; if the change is meant, run npm run golden\n${lineDiff(saved, text)}`);
}

/**
 * Checks the scene's input and output JSON against test/golden/; with
 * UPDATE_GOLDEN=1 re-records them instead. Call after the scene's data is
 * set on `r`.
 */
export async function goldenScene(scene: string, r: Renderer): Promise<void> {
  const input = `${DIR}/${scene}.input.json`;
  const output = `${DIR}/${scene}.json`;
  match(input, stableJson(inputs(r), input));
  match(output, stableJson(await outputs(), output));
}
