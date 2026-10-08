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
import { healthOf } from "../src/shared/pr-health.ts";
import type { SavedCheck, SavedPr, State } from "./state-config.ts";

export const ENTRIES = ["agents", "cockpit"] as const;
export type Entry = (typeof ENTRIES)[number];

/** The saved-state maps each sidebar never reads, so a change to them never reloads it. */
export const UNREAD: Record<Entry, readonly (keyof State)[]> = {
  agents: ["projects", "ui"],
  cockpit: ["ownPrs", "poll", "prOrigins", "published"],
};

// A check with no name: the cockpit's chip counts checks, never names them.
const nameless = (state: SavedCheck["state"]): SavedCheck => ({ name: "", state });

// The fewest checks and merge flags that give a PR the health `pr` has
// (src/shared/pr-health.ts's healthOf, the one rule the chip reads): one
// nameless check per failure, since the chip counts them; one running; one
// passed with the merge verdict for ready; the conflicts flag alone; and
// nothing for quiet, which no check or verdict changes.
function healthFields(pr: SavedPr): Pick<SavedPr, "checks" | "mergeable" | "conflicts"> {
  const checks = pr.checks ?? [];
  switch (healthOf(pr, checks)) {
    case "failing":
      return { checks: checks.filter((c) => c.state === "fail").map(() => nameless("fail")) };
    case "conflicts":
      return { conflicts: true };
    case "running":
      return { checks: [nameless("pending")] };
    case "ready":
      return { checks: [nameless("pass")], mergeable: true };
    case "quiet":
      return {};
  }
}

/**
 * A saved PR cut to what the cockpit shows of it. Its card shows checks and
 * GitHub's merge verdict only as the chip's health, so those are cut to the
 * fewest that keep that health (healthFields). A PR that is not open shows
 * only its number, status and title, so its draft marker and diff size go
 * too. One check passing while another still runs, a check renamed, a check
 * joining the running ones, or a merge verdict flipping while the chip says
 * running then leaves the cockpit's file as it was, and only the agents
 * panel, which lists each check, redraws.
 */
export function cockpitPr(pr: SavedPr): SavedPr {
  const { checks: _checks, mergeable: _mergeable, conflicts: _conflicts, ...shown } = pr;
  if (pr.status !== "open") {
    const { draft: _draft, additions: _additions, deletions: _deletions, ...closed } = shown;
    return closed;
  }
  return { ...shown, ...healthFields(pr) };
}

/** `state` without the maps `entry` never reads, and the cockpit's PRs cut to what it shows. */
export function stateFor(entry: Entry, state: State): Partial<State> {
  const out: Partial<State> = { ...state };
  for (const k of UNREAD[entry]) delete out[k];
  if (entry === "cockpit")
    out.prs = Object.fromEntries(Object.entries(state.prs).map(([id, pr]) => [id, cockpitPr(pr)]));
  return out;
}

/** What the build bakes into every sidebar, before stateFor trims the state. */
export interface Baked {
  projects: unknown;
  state: State;
  unreadable: boolean;
  urlToken: string;
  /** The home folder, so the cockpit can expand a typed "~" (src/shared/home.ts). */
  home: string;
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
      __HOME__: JSON.stringify(baked.home),
    },
    logLevel: "warning",
    write: false,
  };
}
