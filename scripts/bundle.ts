// How scripts/build.ts bundles a sidebar, shared with test/bundle.test.ts
// so the test builds exactly what cmux loads.
//
// A sidebar is baked with only the saved state it reads (UNREAD lists what
// it leaves out). cmux reloads a sidebar whenever its file changes, a
// visible flicker, so a write to a map it never reads, such as one the
// native sidebar keeps, leaves the file untouched (write-if-changed.ts).
// The test holds the list to the bundle: a sidebar that starts reading a
// key it leaves out fails it.

import type { BuildOptions } from "esbuild";
import type { SavedTask, State } from "./state-config.ts";

export const ENTRIES = ["agents"] as const;
export type Entry = (typeof ENTRIES)[number];

/** The saved-state maps each sidebar never reads, so a change to them never reloads it. */
export const UNREAD: Record<Entry, readonly (keyof State)[]> = {
  agents: ["projects", "ui", "laneNames"],
};

/** A saved background task as a sidebar is given it: without its seenEpoch stamp. */
export type BakedTask = Omit<SavedTask, "seenEpoch">;

/** The saved state as a sidebar reads it (src/shared/persist.ts): background tasks unstamped. */
export type SidebarState = Omit<State, "background"> & { background?: Record<string, BakedTask[]> };

/** What stateFor bakes: SidebarState less the maps the sidebar never reads. */
export type BakedState = Partial<SidebarState>;

// The background hook restamps each task's seenEpoch on every turn end and
// asks for no build when only the stamps moved (report-background.ts's
// unstamped). No sidebar reads the stamp, so it is left out: baked in, a
// build for any other reason would carry the moved stamps and reload the
// panel for nothing.
const unstamped = (tasks: readonly SavedTask[]): BakedTask[] => tasks.map(({ seenEpoch: _, ...t }) => t);

/** `state` without the maps `entry` never reads, and without the background stamps. */
export function stateFor(entry: Entry, state: State): BakedState {
  const { background, ...rest } = state;
  const out: BakedState = { ...rest };
  if (background) {
    out.background = Object.fromEntries(Object.entries(background).map(([ws, tasks]) => [ws, unstamped(tasks)]));
  }
  for (const k of UNREAD[entry]) delete out[k];
  return out;
}

/** What the build bakes into every sidebar, before stateFor trims the state. */
export interface Baked {
  projects: unknown;
  /** The lane table (src/shared/lane-config.ts), every gap filled. */
  lanes: unknown;
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
      __LANES__: JSON.stringify(baked.lanes),
      __STATE__: JSON.stringify(stateFor(entry, baked.state)),
      __STATE_UNREADABLE__: JSON.stringify(baked.unreadable),
      __URL_TOKEN__: JSON.stringify(baked.urlToken),
    },
    logLevel: "warning",
    write: false,
  };
}
