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
// saved last (docs/state-loop.md).
//   node scripts/build.ts    build once

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { build } from "esbuild";
import { type Project, validateProjects } from "./projects-config.ts";
import { emptyState, type State, validateState } from "./state-config.ts";

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
function loadState(): State {
  const path = "config/state.json";
  if (!existsSync(path)) return emptyState();
  try {
    return validateState(JSON.parse(readFileSync(path, "utf8")));
  } catch (err) {
    console.warn(`build: cannot read or parse ${path}, starting from empty state: ${(err as Error).message}`);
    return emptyState();
  }
}

const projects = withExpandedRoots(loadProjects());
const state = loadState();

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
    define: { __PROJECTS__: JSON.stringify(projects), __STATE__: JSON.stringify(state) },
    logLevel: "warning",
  });
}
