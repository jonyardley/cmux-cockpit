// The panel's Made here list, and the faint line that stands in for empty
// sections.
// Pure reads of `data`, so each is testable alone.

import type { SavedPublished } from "../../scripts/state-config.ts";
import { mostActive } from "../shared/activity.ts";
import type { Last } from "../shared/list.ts";
import { agentsOf } from "../shared/needs.ts";
import { type Project, savedProjectFor } from "../shared/projects.ts";
import { savedPublished } from "../shared/published.ts";
import { ageSince, nowEpoch } from "../shared/time.ts";
import { footText, isExpanded, markLastBefore } from "./lists.ts";

import { chatWs, cur } from "./model.ts";
import { subagents } from "./team.ts";
import { T } from "./theme.ts";

// ---- Made here ------------------------------------------------------------------
// Pages and docs agents published (#52), from the saved state the published
// hook writes (src/shared/published.ts). Empty without the hook: the
// section then folds into emptyNote's line at the bottom.

export interface MadeEntry {
  key: string;
  url: string;
  title: string;
  /** The project of the workspace it was made in; none when that workspace has gone. */
  project: Project;
  /** Made, or last edited, in the selected workspace. */
  here: boolean;
  epoch: number;
  /** The workspace the row's right-click Open chat goes to (chatWs); none once it has gone. */
  chat: string | undefined;
}

/** What a Made here row reads from the workspace that made it, once per workspace. */
interface MadeWs {
  directory: string | undefined;
  chat: string | undefined;
}

/** The selected workspace's own entries shown at most. */
const MADE_HERE_OWN = 5;
/** Other workspaces' entries shown at most, the latest few. */
const MADE_ELSEWHERE = 3;

function madeEntry(e: SavedPublished, wsOf: (id: string) => MadeWs | undefined, here: boolean): MadeEntry {
  const w = wsOf(e.workspace);
  return {
    key: "m:" + e.url,
    url: e.url,
    // Not readable(): that is for agent chat, and would blank a title with
    // no Latin letters. The hook already checked it (isLabel).
    title: e.title.trim() || "Untitled",
    project: savedProjectFor(w?.directory, e.workspace),
    here,
    epoch: e.epoch,
    chat: w?.chat,
  };
}

// The saved pages and docs still fresh, the selected workspace's id with
// them; none before the clock's first tick, when every entry would
// otherwise read as fresh.
// One computed, so the rows and the count read the same list, filtered once.
// Split once into the selected workspace's own and the rest, with the caps
// each part is cut to while the card is folded, so the rows and the count
// left out read the same cut.
const freshMade = computed(() => {
  const now = nowEpoch();
  const workspaces = data.workspaces() ?? [];
  const selected = workspaces.find((w) => w.selected)?.id;
  const fresh: SavedPublished[] = now ? savedPublished(now) : [];
  const own: SavedPublished[] = [];
  const others: SavedPublished[] = [];
  for (const e of fresh) (e.workspace === selected ? own : others).push(e);
  const shown = Math.min(own.length, MADE_HERE_OWN) + Math.min(others.length, MADE_ELSEWHERE);
  return { count: fresh.length, own, others, over: fresh.length - shown, workspaces };
});

// How many fresh pages and docs the caps leave out while the card is folded.
const madeOver = (): number => freshMade().over;

/** The Made here rows: the selected workspace's own pages and docs first,
 * newest first, then the latest few from other workspaces, or all of them
 * while the card is open. Anything past
 * seven days drops off (shared/published-age.ts); nothing shows before the
 * clock's first tick, when every entry would otherwise read as fresh. */
export const madeHere = computed((): Last<MadeEntry>[] => {
  const f = freshMade();
  // Cut to the rows shown before the project lookups, which scan every project.
  const open = isExpanded("made");
  const own = open ? f.own : f.own.slice(0, MADE_HERE_OWN);
  const others = open ? f.others : f.others.slice(0, MADE_ELSEWHERE);
  const byId = new Map(f.workspaces.map((w) => [w.id, w]));
  // Read once per workspace a shown row names, not per row.
  const seen = new Map<string, MadeWs | undefined>();
  const wsOf = (id: string): MadeWs | undefined => {
    if (!seen.has(id)) {
      const w = byId.get(id);
      seen.set(id, w && { directory: w.directory, chat: chatWs(w, mostActive(agentsOf(w))) });
    }
    return seen.get(id);
  };
  const rows = [...own.map((e) => madeEntry(e, wsOf, true)), ...others.map((e) => madeEntry(e, wsOf, false))];
  return markLastBefore(rows, madeOver());
});

/** Every fresh page and doc, before the caps, for the heading's count. */
export const madeCount = computed((): number => freshMade().count);

/** The Made here card's closing line, from footText. */
export const madeFoot = computed((): string => footText(madeOver(), isExpanded("made")));

/**
 * The one faint line at the bottom that stands in for empty sections
 * (issue #80): the selected workspace's Helpers, and Made here. Worded
 * for what is actually empty; "" when neither is. Helpers only counts
 * while the selected workspace has a live agent, since the block lives on
 * its card and a plain shell has none to run; Made here only once the
 * clock has ticked, since before that no entry counts as fresh.
 */
export const emptyNote = computed((): string => {
  const live = cur().agents.some((a) => a.status !== "ended");
  const noSubs = live && subagents().length === 0;
  const noMade = nowEpoch() > 0 && madeCount() === 0;
  if (noSubs && noMade) return "No helpers or published links yet";
  if (noSubs) return "No helpers yet";
  return noMade ? "No published links yet" : "";
});

/** Other workspaces' titles sit a step back, so this workspace's lead. */
export const madeTitleColor = (e: MadeEntry): string => (e.here ? T.text : T.secondary);

/** A Made here row's age, "3h" since it was last published or edited. */
export const madeAge = (e: MadeEntry): string => ageSince(e.epoch);
