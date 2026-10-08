// Golden JSON for the native core (npm run golden re-records it).
//
// For each cockpit scene in scenes.ts, writes what the scene starts from
// (test/golden/<scene>.input.json: the cmux data, the saved state and the
// project table) and what the TypeScript model computes from it
// (test/golden/<scene>.json: lanes and placement, Needs you, lane entries,
// Projects entries and headers, each card's chips, and Next). Plain values only, no view tree; workspaces
// are named by id. Keys are sorted at every level and the clock is the
// scene's fixed EPOCH, so a file changes only when the model's answer does.
// Biome lays the text out, as it does every JSON file here. Any drift
// fails the test with a diff, as the text snapshots do.
// test/golden/README.md documents every field: it is the contract the Rust
// side reads.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { it } from "node:test";
import type { Chip } from "../../src/cockpit/card-chips.ts";
import type { Renderer } from "./renderer.ts";
import { SCENES, type SceneName } from "./scenes.ts";
import { lineDiff, seed } from "./snapshot.ts";

const DIR = "test/golden";
const UPDATE = process.env.UPDATE_GOLDEN === "1";
// The repo's own Biome, found from here rather than the working directory.
const BIOME = join(import.meta.dirname, "..", "..", "node_modules", ".bin", "biome");

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
  const out = spawnSync(BIOME, ["format", `--stdin-file-path=${file}`], {
    input: raw,
    encoding: "utf8",
  });
  assert.equal(out.status, 0, `biome could not format ${file}: ${out.stderr}`);
  return out.stdout;
}

// Read once per call, after the sidebar loaded: a static import here would
// load the model before the test seeds the saved state it reads at import.
async function cockpit() {
  const [lanes, model, entries, strip, next, byProject, status, state, chips, row, merged] = await Promise.all([
    import("../../src/cockpit/lanes.ts"),
    import("../../src/cockpit/model.ts"),
    import("../../src/cockpit/lane-entries.ts"),
    import("../../src/cockpit/strip.ts"),
    import("../../src/cockpit/next.ts"),
    import("../../src/cockpit/by-project.ts"),
    import("../../src/cockpit/status.ts"),
    import("../../src/cockpit/state.ts"),
    import("../../src/cockpit/card-chips.ts"),
    import("../../src/cockpit/chips.ts"),
    import("../../src/cockpit/merged.ts"),
  ]);
  return { lanes, model, entries, strip, next, byProject, status, state, chips, row, merged };
}

// Each module kept apart, so a name two of them export cannot shadow the other.
type Model = Awaited<ReturnType<typeof cockpit>>;

const ids = (ws: readonly Workspace[]): string[] => ws.map((w) => w.id);

/**
 * Each workspace's lane, size, status and project, keyed by id. Its rank
 * within the lane is left out: the order of laneEntries already says it,
 * and the selected card's rank remembers earlier renders, which no input
 * file could carry.
 */
function placement({ model: m, byProject, status }: Model): Record<string, Json> {
  const cardIds = new Set(ids(m.cards()));
  return Object.fromEntries(
    m.allWorkspaces().map((w) => [
      w.id,
      {
        actualLane: m.actualLaneOf(w),
        card: cardIds.has(w.id),
        density: m.cardDensity(w),
        lane: m.laneOf(w),
        project: byProject.projectKey(w),
        status: status.statusOf(w),
      },
    ]),
  );
}

/** Each lane header: folded or not, the cards it counts, its merge line. */
function laneHeaders({ lanes, model, entries }: Model): Record<string, Json> {
  return Object.fromEntries(
    lanes.LANES.map((lane) => [
      lane.key,
      {
        collapsed: model.isCollapsed(lane),
        mergeReady: entries.mergeReadyText(lane.key),
        workspaces: ids(entries.laneWorkspaces(lane.key)),
      },
    ]),
  );
}

function needs({ strip }: Model): Json {
  return {
    inStrip: [...strip.inStrip()],
    late: strip.needsWaitLate(),
    list: ids(strip.needsList()),
    more: strip.needsMore(),
    shown: ids(strip.needsShown()),
    waitText: strip.needsWaitText(),
  };
}

/**
 * Each card's chips (chipsFor with the branch, as the full and project
 * cards ask for it), how they fit each card's line, and a merged card's
 * dimming, keyed by id.
 */
function chipsOut({ model, chips, row, merged }: Model): Record<string, Json> {
  const fit = (drawn: Chip[], chars: number): Json => ({
    fitsOneLine: row.chipsFitOneLine(drawn, chars),
    splits: row.chipsSplit(drawn, chars),
  });
  return Object.fromEntries(
    model.cards().map((w) => {
      const drawn = chips.chipsFor(w, true);
      return [
        w.id,
        {
          cardOpacity: merged.cardOpacity(w, false),
          // Copied to plain objects, which Json takes and the Chip interfaces are not.
          chips: drawn.map((c) => ({ ...c })),
          fullLine: fit(drawn, row.FULL_LINE_CHARS),
          projectLine: fit(drawn, row.PROJECT_LINE_CHARS),
        },
      ];
    }),
  );
}

/** Each project the Projects view heads, busy or quiet: its name, the cards it counts, and its "+". */
function projectHeaders({ byProject }: Model): Record<string, Json> {
  const keys = byProject
    .projectEntries()
    .flatMap((e) => (e.kind === "header" || e.kind === "quietRow" ? [e.project] : []));
  return Object.fromEntries(
    keys.map((k) => [
      k,
      {
        canOpen: byProject.canOpenProject(k),
        name: byProject.projectByKey(k).name,
        workspaces: ids(byProject.projectWorkspaces(k)),
      },
    ]),
  );
}

function nextOut({ next }: Model): Json {
  const step = next.nextStep();
  return {
    queue: ids(next.nextQueue()),
    step: step ? { position: step.position, target: step.target.id, total: step.total } : null,
  };
}

/** What the model computes for the scene now on the fake renderer. */
async function outputs(): Promise<Json> {
  const m = await cockpit();
  return {
    chips: chipsOut(m),
    laneEntries: m.entries.flatEntries(),
    laneHeaders: laneHeaders(m),
    mode: m.state.mode(),
    needs: needs(m),
    next: nextOut(m),
    placement: placement(m),
    projectEntries: m.byProject.projectEntries(),
    projectHeaders: projectHeaders(m),
    quietProjects: m.byProject.quietProjects(),
  };
}

/** What the scene starts from: the cmux data, and what the build bakes in. */
function inputs(r: Renderer): unknown {
  // The build's defines, which seed() and renderer.ts set on globalThis.
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
 * A scene's golden test: seeds it, loads the cockpit, sets its data, then
 * checks its input and output JSON against test/golden/, or with
 * UPDATE_GOLDEN=1 re-records them. One scene per test file, since the
 * sidebar reads the saved state once, at load.
 */
export async function goldenTest(scene: SceneName): Promise<void> {
  const s = SCENES[scene];
  const r = seed(s.seed());
  await import("../../src/cockpit/index.ts");
  it(`${scene}: the model's answers match test/golden/`, async () => {
    s.data(r);
    const input = `${DIR}/${scene}.input.json`;
    const output = `${DIR}/${scene}.json`;
    match(input, stableJson(inputs(r), input));
    match(output, stableJson(await outputs(), output));
  });
}
