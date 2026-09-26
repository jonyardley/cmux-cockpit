// Bundles each src/<name>/index.ts entry into sidebars/<name>.js, the flat script
// cmux loads. Sidebars cannot import, so shared modules are inlined here.
// The project table is read from config/projects.json (gitignored, Jon's real
// table), falling back to the committed config/projects.example.json, and
// injected as the __PROJECTS__ define so src/shared/projects.ts can read it.
//   node scripts/build.ts    build once

import { existsSync, readFileSync } from "node:fs";
import { build } from "esbuild";
import { type Project, validateProjects } from "./projects-config.ts";

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

const projects = loadProjects();

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
    define: { __PROJECTS__: JSON.stringify(projects) },
    logLevel: "warning",
  });
}
