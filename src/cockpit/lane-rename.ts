// A lane renamed in config/lanes.json takes its cmux group with it (issue
// #294), so its cards stay in the lane rather than falling to Unsorted.
//
// Each lane id's last name is kept in local state (laneNames); a lane with
// none saved is taken to have its built-in name (main is "Main activity").
// When lanes.json gives a different name, the group still under the old
// name is renamed, once, and the new name is saved only when cmux shows a
// group under it, so a rename cmux dropped is asked again after a reload.
// A group already under the new name is the lane's now: the old one is
// left alone. A lane whose new name is another renamed lane's old name
// waits for that lane's group to move first, so a chain of renames
// (main takes "For review" while review becomes "To check") follows
// through; a swap waits for ever and renames neither. A lane seen for the
// first time is saved once a group under its name exists. The native core
// does the same (native/core/src/lane_rename.rs).
//
// The group's generated anchor is renamed too, and the name is saved only
// once the anchor shows the new title: the cockpit knows an anchor by its
// title matching the group's name (shared/anchors.ts), so one left under
// the old title would show as a card.

import { persistSet, SAVED_STATE, STATE_UNREADABLE } from "../shared/persist.ts";
import { builtInName } from "./lane-config.ts";
import { LANES, UNSORTED_KEY } from "./lanes.ts";

// SAVED_STATE is baked in at build and a laneNames write rebuilds nothing,
// so what this session already saved is held here: lane id -> name.
const saved = new Map<string, string>();
// Renames asked of cmux this session, so each is asked once: "group:<lane
// id>" or "anchor:<workspace id>" -> the name asked for.
const asked = new Map<string, string>();

const lastName = (id: string): string | undefined => saved.get(id) ?? SAVED_STATE.laneNames?.[id] ?? builtInName(id);

const norm = (s: string | undefined): string => (s ?? "").trim().toLowerCase();

interface Change {
  id: string;
  from: string | undefined;
  to: string;
}

/**
 * Follows each lane renamed since its name was last saved, and saves the
 * name of a lane seen for the first time. Idempotent: run from the read
 * every frame starts with, it asks each rename once and writes only when
 * a name changed. Does nothing when the state file could not be read,
 * since every lane would then look new.
 */
export function renameLaneGroups(): void {
  const list = data.groups();
  if (STATE_UNREADABLE || !list) return;
  const changes: Change[] = LANES.filter((l) => l.key !== UNSORTED_KEY)
    .map((l) => ({ id: l.key, from: lastName(l.key), to: l.name }))
    .filter((c) => c.from !== c.to);
  const named = (n: string): WorkspaceGroup | undefined => list.find((g) => g.name === n);
  // Old names still on a group, which no other lane may take yet.
  const leaving = new Set(changes.flatMap((c) => (c.from !== undefined && named(c.from) ? [c.from] : [])));
  for (const c of changes) {
    if (leaving.has(c.to)) continue;
    const now = named(c.to);
    if (now) settle(c, now);
    else if (c.from !== undefined) askGroup(c, named(c.from));
  }
}

// The lane's group is under its new name: saves it once the anchor, if
// it has one, is under the new title too.
function settle(c: Change, g: WorkspaceGroup): void {
  if (c.from !== undefined && g.anchorId) {
    const anchor = (data.workspaces() ?? []).find((w) => w.id === g.anchorId);
    if (!anchor) return; // not sent yet
    if (norm(anchor.title) === norm(c.from)) {
      ask(`anchor:${anchor.id}`, c.to, () => cmux("workspace.rename", { workspace_id: anchor.id, title: c.to }));
      return;
    }
  }
  persistSet(`laneNames.${c.id}`, c.to);
  saved.set(c.id, c.to);
}

function askGroup(c: Change, old: WorkspaceGroup | undefined): void {
  if (old) ask(`group:${c.id}`, c.to, () => cmux("workspace.group.rename", { group_id: old.id, name: c.to }));
}

function ask(key: string, name: string, send: () => void): void {
  if (asked.get(key) === name) return;
  asked.set(key, name);
  send();
}
