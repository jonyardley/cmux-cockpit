// Bundles each src/<name>/index.ts entry into sidebars/<name>.js, the flat script
// cmux loads. Sidebars cannot import, so shared modules are inlined here.
// The project table is read from config/projects.json (gitignored, Jon's real
// table), falling back to the committed config/projects.example.json, and
// injected as the __PROJECTS__ define so src/shared/projects.ts can read it.
// A `root` field's leading `~` is expanded against HOME here, since a sidebar
// has no filesystem access to do it at runtime.
//
// config/lanes.json (gitignored) is the lane table, checked by the native
// core's rules (src/cockpit/lane-config.ts) and injected as __LANES__ with
// every gap filled. With no file it is today's four lanes; a file that
// breaks a rule fails the build, as a bad project table does.
//
// config/state.json (gitignored, written by the URL handler) is read the
// same way and injected as __STATE__, so a sidebar starts from whatever was
// saved last (docs/state-loop.md), with __STATE_UNREADABLE__ true when the
// file cannot be read, or an unreadable one was kept aside and is still there. Its `projects` map, projects made or
// edited in the sidebar (issue #9), is laid over the file's table first.
//
// config/url-token (gitignored, this user only) is made here on the first
// build and baked in as __URL_TOKEN__, so the sidebars' cmux-cockpit://
// links carry it and state-set.ts can refuse any link that does not
// (docs/state-loop.md).
//
// A bundle is written only when its bytes differ from the one on disk
// (write-if-changed.ts), and each carries only the saved state it reads
// (bundle.ts), since every write reloads that sidebar in cmux.
//
//   node scripts/build.ts    build once

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { build } from "esbuild";
import { BUILT_IN_LANES, type LaneSpec, resolveLanes, unrecordedLanes } from "../src/cockpit/lane-config.ts";
import { expandHome } from "../src/shared/home.ts";
import { bundleOptions, ENTRIES } from "./bundle.ts";
import { changedKeys, takeTags } from "./hook-build.ts";
import { isLiveCheckout } from "./live-checkout.ts";
import { mergeProjects, type Project, validateProjects } from "./projects-config.ts";
import { emptyState, isRecord, type State, validateState } from "./state-config.ts";
import { logLine, redrawLine } from "./state-log.ts";
import { ensureUrlToken, keepUnreadableCopy, readApplyWrite, unreadableCopyOf } from "./state-url.ts";
import { BUILT_MARK, touchBuilt, writeIfChanged } from "./write-if-changed.ts";

function loadProjects(): readonly Project[] {
  const real = "config/projects.json";
  const example = "config/projects.example.json";
  const path = existsSync(real) ? real : example;
  console.log(`build: using ${path}`);

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    console.error(`build: cannot read or parse ${path}: ${(err as Error).message}`);
    process.exit(1);
  }
  const result = validateProjects(parsed);
  if (!result.ok) {
    console.error(`build: ${path} ${result.error}`);
    process.exit(1);
  }
  return result.projects;
}

function loadLanes(): readonly LaneSpec[] {
  const path = "config/lanes.json";
  if (!existsSync(path)) return BUILT_IN_LANES;
  console.log(`build: using ${path}`);

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    console.error(`build: cannot read or parse ${path}: ${(err as Error).message}`);
    process.exit(1);
  }
  const result = resolveLanes(parsed);
  if (!result.ok) {
    console.error(`build: ${path}: ${result.error}`);
    process.exit(1);
  }
  return result.lanes;
}

// Saves the name of each lane that has none saved and no built-in one
// (issue #294), so renaming it later in lanes.json can rename its cmux
// group: the sidebars only write when a lane is renamed, never on a plain
// draw. Skipped for an unreadable file, and a write that fails leaves the
// lane unrecorded, to be tried on the next build.
function recordLaneNames(state: State): State {
  let laneNames = state.laneNames;
  for (const lane of unrecordedLanes(lanes, laneNames)) {
    try {
      const result = readApplyWrite(STATE_PATH, `laneNames.${lane.id}`, JSON.stringify(lane.name));
      if (result.ok) laneNames = { ...laneNames, [lane.id]: lane.name };
      else console.warn(`build: lane "${lane.name}" not recorded: ${result.error}`);
    } catch (err) {
      console.warn(`build: lane "${lane.name}" not recorded: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return laneNames ? { ...state, laneNames } : state;
}

// Expands a leading "~" (bare, or "~/...") against HOME; other roots pass
// through. A real home folder always expands, so the root itself is only a
// fallback the types ask for.
function withExpandedRoots(projects: readonly Project[]): readonly Project[] {
  return projects.map((p) => (p.root ? { ...p, root: expandHome(p.root, homedir()) ?? p.root } : p));
}

// A bad or missing state file must never break the build: it is Jon's saved
// dismissals and project overrides, not something CI or a clean clone has.
// A missing file is a clean start; one that is there but cannot be read or
// is not a JSON object is flagged, so the sidebars say so rather than look
// empty (issue #78). The next write (a poll, a hook, a tap) would replace
// it with near-empty state and the flag would go with it, so the broken
// file is first copied aside, never over an earlier copy (the writes in
// state-url.ts do the same before replacing it), and the flag holds while
// that copy is there: the saved state was lost, and the line stays until
// Jon has looked at the copy and removed it.
const STATE_PATH = "config/state.json";
const BROKEN_COPY = unreadableCopyOf(STATE_PATH);

function keepBrokenCopy(): void {
  try {
    if (keepUnreadableCopy(STATE_PATH)) console.warn(`build: kept the unreadable file as ${BROKEN_COPY}`);
  } catch {
    // The copy failed: the flag still shows.
  }
}

// `broken` is this file alone; `unreadable` also holds while an earlier
// broken file's copy is still there.
interface Loaded {
  state: State;
  unreadable: boolean;
  broken: boolean;
}

function unreadableState(why: string): Loaded {
  console.warn(`build: ${STATE_PATH} ${why}, starting from empty state`);
  keepBrokenCopy();
  return { state: emptyState(), unreadable: true, broken: true };
}

function loadState(): Loaded {
  const kept = existsSync(BROKEN_COPY);
  if (!existsSync(STATE_PATH)) return { state: emptyState(), unreadable: kept, broken: false };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(STATE_PATH, "utf8"));
  } catch (err) {
    return unreadableState(`cannot be read or parsed (${err instanceof Error ? err.message : String(err)})`);
  }
  if (!isRecord(raw)) return unreadableState("is not a JSON object");
  return { state: validateState(raw), unreadable: kept, broken: false };
}

// Unlike the state file, a token that cannot be made is fatal: a bundle
// without one sends links the handler refuses, so every save would fail.
function loadUrlToken(): string {
  try {
    return ensureUrlToken("config/url-token");
  } catch (err) {
    console.error(`build: cannot make or read config/url-token: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

// The state the last build baked in, so the log can name the keys a build
// carries that it did not. null when there is none yet or it cannot be
// read, so every key counts as changed.
const LAST_BUILT = "config/last-built-state.json";

function loadLastBuilt(): Record<string, unknown> | null {
  try {
    const raw: unknown = JSON.parse(readFileSync(LAST_BUILT, "utf8"));
    return isRecord(raw) ? raw : null;
  } catch {
    return null;
  }
}

// Best-effort, like the log: losing it only widens the next line's keys.
function saveLastBuilt(baked: State): void {
  try {
    writeFileSync(LAST_BUILT, JSON.stringify(baked));
  } catch {
    // ignored
  }
}

const urlToken = loadUrlToken();
const table = loadProjects();
const lanes = loadLanes();
// Taken after the steps that can exit, so a bad project or lane table never drops
// tags unlogged, and just before the state is read, so a tag almost always
// stands for a write this build includes. A hook records its tag just
// after its write, so one that writes between the take and the read is
// built here and named on the next line instead.
const tags = takeTags();
const { state: loaded, unreadable, broken } = loadState();
const saved = unreadable ? loaded : recordLaneNames(loaded);
const merged = mergeProjects(table, saved.projects);
const projects = withExpandedRoots(merged.projects);
// Only the saved projects that survived the merge, so the sidebar edits from
// what actually shows.
const state: State = { ...saved, projects: merged.kept };

// Each rewrite is a full redraw in cmux, so the live checkout logs them next
// to the poller's lines, to set against cmux's hang reports. Logged even when
// a later sidebar fails, since the earlier one has already redrawn.
// An unreadable file names no keys, and leaves the last bake in place so
// the next readable build is set against real state, not an empty one.
const written: string[] = [];
const changed = broken ? null : changedKeys(loadLastBuilt(), state);
try {
  for (const name of ENTRIES) {
    const result = await build(bundleOptions(name, { projects, lanes, state, unreadable, urlToken, home: homedir() }));
    const rewrote = result.outputFiles.map((out) => writeIfChanged(out.path, out.contents));
    if (rewrote.includes(true)) written.push(name);
  }
  if (!broken) saveLastBuilt(state);
} finally {
  if (isLiveCheckout(process.cwd())) logLine(redrawLine(written, { tags, changed }));
}
// The doctor's freshness mark: a bundle left untouched keeps its old time,
// so the build's own time is kept here instead.
touchBuilt(BUILT_MARK);
