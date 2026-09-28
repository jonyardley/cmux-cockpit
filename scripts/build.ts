// Bundles each src/<name>/index.ts entry into sidebars/<name>.js, the flat script
// cmux loads. Sidebars cannot import, so shared modules are inlined here.
// The project table is read from config/projects.json (gitignored, Jon's real
// table), falling back to the committed config/projects.example.json, and
// injected as the __PROJECTS__ define so src/shared/projects.ts can read it.
// A `root` field's leading `~` is expanded against HOME here, since a sidebar
// has no filesystem access to do it at runtime.
//
// config/state.json (gitignored, written by the URL handler) is read the
// same way and injected as __STATE__, so a sidebar starts from whatever was
// saved last (docs/state-loop.md), with __STATE_UNREADABLE__ true when the
// file cannot be read, or an unreadable one was kept aside and is still there. Its `projects` map, projects made in the
// sidebar (issue #9), is merged over the file's table first.
//   node scripts/build.ts    build once

import { constants, copyFileSync, existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { build } from "esbuild";
import { mergeProjects, type Project, validateProjects } from "./projects-config.ts";
import { emptyState, isRecord, type State, validateState } from "./state-config.ts";

const ENTRIES = ["agents", "cockpit"] as const;

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

/** Expands a leading `~` (bare, or `~/...`) against HOME. Other roots pass through. */
function expandRoot(root: string): string {
  if (root === "~") return homedir();
  if (root.startsWith("~/")) return homedir() + root.slice(1);
  return root;
}

function withExpandedRoots(projects: readonly Project[]): readonly Project[] {
  return projects.map((p) => (p.root ? { ...p, root: expandRoot(p.root) } : p));
}

// A bad or missing state file must never break the build: it is Jon's saved
// dismissals and project overrides, not something CI or a clean clone has.
// A missing file is a clean start; one that is there but cannot be read or
// is not a JSON object is flagged, so the sidebars say so rather than look
// empty (issue #78). The next write (a poll, a hook, a tap) would replace
// it with near-empty state and the flag would go with it, so the broken
// file is first copied aside, never over an earlier copy, and the flag
// holds while that copy is there: the saved state was lost, and the line
// stays until Jon has looked at the copy and removed it.
const STATE_PATH = "config/state.json";
const BROKEN_COPY = "config/state.json.unreadable.bak";

function keepBrokenCopy(): void {
  try {
    copyFileSync(STATE_PATH, BROKEN_COPY, constants.COPYFILE_EXCL);
    console.warn(`build: kept the unreadable file as ${BROKEN_COPY}`);
  } catch {
    // Already kept from an earlier build, or the copy failed: the flag still shows.
  }
}

function unreadableState(why: string): { state: State; unreadable: boolean } {
  console.warn(`build: ${STATE_PATH} ${why}, starting from empty state`);
  keepBrokenCopy();
  return { state: emptyState(), unreadable: true };
}

function loadState(): { state: State; unreadable: boolean } {
  const kept = existsSync(BROKEN_COPY);
  if (!existsSync(STATE_PATH)) return { state: emptyState(), unreadable: kept };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(STATE_PATH, "utf8"));
  } catch (err) {
    return unreadableState(`cannot be read or parsed (${err instanceof Error ? err.message : String(err)})`);
  }
  if (!isRecord(raw)) return unreadableState("is not a JSON object");
  return { state: validateState(raw), unreadable: kept };
}

const { state: saved, unreadable } = loadState();
const merged = mergeProjects(loadProjects(), saved.projects);
const projects = withExpandedRoots(merged.projects);
// Only the in-app projects that survived the merge, so the sidebar never
// offers to edit one the file overrode.
const state: State = { ...saved, projects: merged.kept };

for (const name of ENTRIES) {
  const outfile = `sidebars/${name}.js`;
  await build({
    entryPoints: [`src/${name}/index.ts`],
    outfile,
    bundle: true,
    // esm with no exports is a flat script: no wrapper, top-level sidebar().
    format: "esm",
    target: "es2022",
    platform: "neutral",
    charset: "utf8",
    legalComments: "none",
    banner: { js: `// GENERATED from src/${name}/ by \`npm run build\`. Do not edit.` },
    define: {
      __PROJECTS__: JSON.stringify(projects),
      __STATE__: JSON.stringify(state),
      __STATE_UNREADABLE__: JSON.stringify(unreadable),
    },
    logLevel: "warning",
  });
}
