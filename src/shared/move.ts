// What a chat wants from Jon when its turn ends: the "Your move" line that
// scripts/hooks/report-move.ts saves, and how big a job answering it is.
// cmux keeps only the start of a message, so the line reaches the sidebar
// through the workspace's description, which cmux sends live, and through
// the saved state when setting the description failed.

import { moveOfDescription, type SavedMove } from "../../scripts/state-config.ts";
import { SAVED_STATE } from "./persist.ts";

// The move a description carries, parsed once per distinct description:
// lastMove runs several times per card on every tick.
const parsed = new Map<string, SavedMove | undefined>();
function liveMove(d: string | undefined): SavedMove | undefined {
  if (d === undefined) return undefined;
  if (parsed.has(d)) return parsed.get(d);
  if (parsed.size >= 64) parsed.clear();
  const m = moveOfDescription(d) ?? undefined;
  parsed.set(d, m);
  return m;
}

/**
 * The move `w`'s chat last ended a turn on: the description's or the saved
 * one, whichever is newer, since a failed description write falls back to
 * the saved map and leaves an older description behind. Whether it still
 * waits on Jon is the Cockpit's call (shared/needs.ts turnStart). The saved
 * map is fixed at build, and a test can seed __STATE__ from before it
 * existed, so it may be missing at runtime.
 */
export function lastMove(w: Workspace): SavedMove | undefined {
  const map: Record<string, SavedMove> | undefined = SAVED_STATE.moves;
  const saved = map && Object.hasOwn(map, w.id) ? map[w.id] : undefined;
  const live = liveMove(w.description);
  if (!live || !saved) return live ?? saved;
  return saved.epoch > live.epoch ? saved : live;
}
