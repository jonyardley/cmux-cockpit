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

/** The lane groups' names, as cockpit/lanes.ts names them (a test holds the two together). */
export const LANE_GROUP_NAMES: readonly string[] = ["Main activity", "For review", "Background", "Parked"];

/** Whether `w`, the anchor of group `g`, is the placeholder cmux generated. */
export function isGeneratedAnchor(g: WorkspaceGroup, w: Workspace | undefined): boolean {
  if (!w) return true;
  // With no name there is nothing to match: a nameless group's untitled
  // anchor is a real card, not a placeholder that "" === "" would hide.
  const name = (g.name ?? "").trim().toLowerCase();
  return name !== "" && (w.title ?? "").trim().toLowerCase() === name;
}

// Whether `w` looks like a lane's placeholder with no group list to go by:
// titled exactly after a lane, with no agent working or asking in it.
function looksLikePlaceholder(w: Workspace, lanes: ReadonlySet<string>): boolean {
  const busy = (w.agents ?? []).some((a) => a?.status === "working" || a?.status === "needs_input");
  return !busy && lanes.has((w.title ?? "").trim().toLowerCase());
}

/**
 * The ids of the lane groups' placeholders in `byId`. Only lane groups, as
 * the cockpit hides no other: a group Jon makes himself keeps its anchor as
 * a real chat whatever it is titled. The agents panel is not sent the group
 * list, so a workspace that looks like a placeholder counts too; its cost is
 * that a real chat titled exactly after a lane, with nothing running, drops
 * out of the PR card.
 */
export function placeholderIds(groups: readonly WorkspaceGroup[], byId: ReadonlyMap<string, Workspace>): Set<string> {
  const out = new Set<string>();
  for (const g of groups) {
    if (!g.name || !LANE_GROUP_NAMES.includes(g.name)) continue;
    const w = g.anchorId ? byId.get(g.anchorId) : undefined;
    if (w && isGeneratedAnchor(g, w)) out.add(w.id);
  }
  const lanes = new Set(LANE_GROUP_NAMES.map((n) => n.toLowerCase()));
  for (const w of byId.values()) if (looksLikePlaceholder(w, lanes)) out.add(w.id);
  return out;
}
