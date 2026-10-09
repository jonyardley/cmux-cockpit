// A lane renamed in config/lanes.json takes its cmux group with it (issue
// #294), so its cards stay in the lane rather than falling to Unsorted.
//
// Each lane id's last name is kept in local state (laneNames). When the
// name lanes.json gives differs, the group still under the old name is
// renamed, but only while no group has the new name: a group already
// called that is the lane's now, and the old one is left alone. Either
// way the new name is saved; with neither group there, nothing is. A lane with no saved name is taken to have
// its built-in name (main is "Main activity"); one with neither is left
// alone, and the build saves its name (unrecordedLanes), so drawing never
// writes anything unless a lane was renamed. The native core does the same (native/core/src/lane_rename.rs);
// whichever runs second finds the new name taken and only saves.
//
// The group's generated anchor is renamed with it: the cockpit knows an
// anchor by its title matching the group's name (shared/anchors.ts), so
// one left under the old title would show as a card.

import { isGeneratedAnchor } from "../shared/anchors.ts";
import { persistSet, SAVED_STATE, STATE_UNREADABLE } from "../shared/persist.ts";
import { builtInName } from "./lane-config.ts";
import { LANES, UNSORTED_KEY } from "./lanes.ts";

// SAVED_STATE is baked in at build and a laneNames write rebuilds nothing,
// so what this session already saved is held here: lane id -> name.
const saved = new Map<string, string>();

const lastName = (id: string): string | undefined => saved.get(id) ?? SAVED_STATE.laneNames?.[id] ?? builtInName(id);

/**
 * Renames the group of each lane whose name changed since it was last
 * saved, then saves the name. Idempotent: run from the read every frame
 * starts with, it acts once per lane per name, and only for a lane
 * renamed. Does nothing when the state file could not be read, since every
 * lane would then look new.
 */
export function renameLaneGroups(): void {
  const list = data.groups();
  if (STATE_UNREADABLE || !list) return;
  for (const lane of LANES) {
    if (lane.key === UNSORTED_KEY) continue;
    const last = lastName(lane.key);
    if (last === undefined || last === lane.name || !renameGroup(list, last, lane.name)) continue;
    persistSet(`laneNames.${lane.key}`, lane.name);
    saved.set(lane.key, lane.name);
  }
}

// Whether the lane's group now goes by `to`: renamed here, or already
// called that. With neither name in the list (no group yet, or cmux has not
// sent its groups) nothing is saved, so the rename waits for a group to
// follow; a lane's first move makes its group under the new name.
function renameGroup(list: readonly WorkspaceGroup[], from: string, to: string): boolean {
  if (list.some((g) => g.name === to)) return true;
  const old = list.find((g) => g.name === from);
  if (!old) return false;
  cmux("workspace.group.rename", { group_id: old.id, name: to });
  const anchor = (data.workspaces() ?? []).find((w) => w.id === old.anchorId);
  if (anchor && isGeneratedAnchor(old, anchor)) cmux("workspace.rename", { workspace_id: anchor.id, title: to });
  return true;
}
