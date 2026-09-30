// How scripts/build.ts bundles one sidebar, shared with test/bundle.test.ts
// so the test builds exactly what cmux loads.
//
// Each sidebar is baked with only the saved state it reads (UNREAD lists
// what each leaves out). cmux reloads a sidebar whenever its file changes,
// a visible flicker, so a write to a map only the other sidebar reads, such
// as the PR poll's okEpoch stamp, now rebuilds that one alone and the build
// leaves the other file untouched (write-if-changed.ts). The test holds
// each list to the bundle: a sidebar that starts reading a key it leaves
// out fails it.

import type { BuildOptions } from "esbuild";
import type { State } from "./state-config.ts";

export const ENTRIES = ["agents", "cockpit"] as const;
export type Entry = (typeof ENTRIES)[number];

/** The saved-state maps each sidebar never reads, so a change to them never reloads it. */
export const UNREAD: Record<Entry, readonly (keyof State)[]> = {
  agents: ["mergeKept", "projects", "ui"],
  cockpit: ["ownPrs", "poll", "prOrigins", "published"],
};

/** `state` without the maps `entry` never reads. */
export function stateFor(entry: Entry, state: State): Partial<State> {
  const out: Partial<State> = { ...state };
  for (const k of UNREAD[entry]) delete out[k];
  return out;
}

/** What the build bakes into every sidebar, before stateFor trims the state. */
export interface Baked {
  projects: unknown;
  state: State;
  unreadable: boolean;
  urlToken: string;
}

/** esbuild's options for one sidebar, built in memory: the caller writes the output. */
export function bundleOptions(entry: Entry, baked: Baked): BuildOptions & { write: false } {
  return {
    entryPoints: [`src/${entry}/index.ts`],
    outfile: `sidebars/${entry}.js`,
    bundle: true,
    // esm with no exports is a flat script: no wrapper, top-level sidebar().
    format: "esm",
    target: "es2022",
    platform: "neutral",
    charset: "utf8",
    legalComments: "none",
    banner: { js: `// GENERATED from src/${entry}/ by \`npm run build\`. Do not edit.` },
    define: {
      __PROJECTS__: JSON.stringify(baked.projects),
      __STATE__: JSON.stringify(stateFor(entry, baked.state)),
      __STATE_UNREADABLE__: JSON.stringify(baked.unreadable),
      __URL_TOKEN__: JSON.stringify(baked.urlToken),
    },
    logLevel: "warning",
    write: false,
  };
}
