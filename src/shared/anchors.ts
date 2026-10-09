// Lane placeholders: the empty workspace cmux makes to hold each lane's
// group. The cockpit draws one as its lane's header, never as a card, and
// the agents panel's PR card skips it, so a PR cmux pins on it (from the
// folder it was made in) never shows as a chat's.
//
// cmux's own group list says which anchors it generated, but the renderer's
// data has no such flag (issue #7), so this is a heuristic pending one: a
// generated anchor's title always matches its group's name, so an anchor
// under that title is the placeholder even with agents running in it (they
// show on the lane header instead). It gets two cases wrong: a real
// workspace Jon titles exactly after its lane hides as the placeholder, and
// a placeholder he renames shows as a card. cmux can also anchor a
// single-member group on a real workspace (e.g. a group made from one
// existing tab), and that one is a real card.
//
// The agents panel is not sent the group list, so there the title alone
// decides: any workspace titled exactly after a lane counts as its
// placeholder, agents running or not, as the group check would. That adds a
// third wrong case there: a real chat titled exactly after a lane drops out
// of the PR card, and an own PR opened from it names no chat.

// The lane table the build bakes in from config/lanes.json (cockpit/lane-config.ts),
// in both sidebars. Only the names matter here, so shared/ reads no cockpit module.
declare const __LANES__: readonly { name: string }[] | undefined;

/** Today's four lanes' names, for a bundle built without the define (cockpit/lanes.ts BUILT_IN_LANES). */
const BUILT_IN_NAMES: readonly string[] = ["Main activity", "For review", "Background", "Parked"];

/** The lane groups' names, as cockpit/lanes.ts names them (a test holds the two together). */
export const LANE_GROUP_NAMES: readonly string[] =
  typeof __LANES__ === "undefined" ? BUILT_IN_NAMES : __LANES__.map((l) => l.name);

// A name or title as the matches compare it.
const norm = (s: string | undefined): string => (s ?? "").trim().toLowerCase();

const LANE_KEYS: ReadonlySet<string> = new Set(LANE_GROUP_NAMES.map(norm));

/** Whether `w`, the anchor of group `g`, is the placeholder cmux generated. */
export function isGeneratedAnchor(g: WorkspaceGroup, w: Workspace | undefined): boolean {
  if (!w) return true;
  // With no name there is nothing to match: a nameless group's untitled
  // anchor is a real card, not a placeholder that "" === "" would hide.
  const name = norm(g.name);
  return name !== "" && norm(w.title) === name;
}

/**
 * The ids of the lane groups' placeholders in `byId`. Only lane groups, as
 * the cockpit hides no other: a group Jon makes himself keeps its anchor as
 * a real chat whatever it is titled. With no group list (the agents panel
 * is sent none), every workspace titled exactly after a lane counts.
 */
export function placeholderIds(groups: readonly WorkspaceGroup[], byId: ReadonlyMap<string, Workspace>): Set<string> {
  const out = new Set<string>();
  if (groups.length === 0) {
    for (const w of byId.values()) if (LANE_KEYS.has(norm(w.title))) out.add(w.id);
    return out;
  }
  for (const g of groups) {
    if (!LANE_KEYS.has(norm(g.name))) continue;
    const w = g.anchorId ? byId.get(g.anchorId) : undefined;
    if (w && isGeneratedAnchor(g, w)) out.add(w.id);
  }
  return out;
}
