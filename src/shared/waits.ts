// The Cockpit's waits on Jon, read from the saved state (#388): a stopped
// session, CI stuck or failed with nobody on it, a change left merge-ready
// four hours, parked Ostinato attempts. The native core alone decides
// them and saves what its cards show (native/core/src/waits_save.rs, the
// saved `waits` map), and which agent carries each in the saved `agents`
// map (shared/needs.ts), so the agents panel names and counts the same
// waits rather than rules of its own.
//
// Dismissing stays in the Cockpit: its dismissal clears the saved wait,
// and the next build bakes the map without it.

import type { SavedWait, WaitWhy } from "../../scripts/state-config.ts";
import { SAVED_STATE } from "./persist.ts";
import { checksOf } from "./prs.ts";
import { WAIT_WORD } from "./words.ts";

/** `wsId`'s saved waits, in the core's order (stops, CI, park); none
 * without any, or from a state file older than the map. */
export function waitsFor(wsId: string): SavedWait[] {
  const map: Record<string, SavedWait[]> | undefined = SAVED_STATE.waits;
  return (map && Object.hasOwn(map, wsId) ? map[wsId] : undefined) ?? [];
}

/** The saved wait an agent `id` carries for `why`, as the core saved it: a
 * stop on its own session, else the workspace's CI or park wait. None for
 * a turn or an ask, or when the waits map lags the agents map. */
export function waitOf(why: WaitWhy | undefined, id: string, waits: readonly SavedWait[]): SavedWait | undefined {
  if (why === "stop") return waits.find((v) => v.kind === "stopped" && v.agent === id);
  if (why === "ci")
    return waits.find((v) => v.kind === "ci_stuck" || v.kind === "ci_failing" || v.kind === "merge_ready");
  if (why === "park") return waits.find((v) => v.kind === "park");
  return undefined;
}

// Words

/** A clock time, "11:20", in the Mac's own time zone; "" for a bad input. */
export function clockTime(epoch: number): string {
  if (!(epoch > 0)) return "";
  const d = new Date(epoch * 1000);
  const two = (n: number): string => String(n).padStart(2, "0");
  return two(d.getHours()) + ":" + two(d.getMinutes());
}

// A stop's cause, as the Cockpit's closing line has it (words.rs stop_words).
const STOP_DETAIL: Record<string, string> = { error: "on an error", gone: "mid-turn", silent: "silent" };

// A stuck check in words. The saved time is when it was queued, or when it
// started once it runs, and the wait does not say which, so the PR's own
// copy of the check, found by name, tells them apart. A copy no longer
// pending (the wait lags a rebuild) gets the neutral words.
function stuckDetail(wait: SavedWait, w: Workspace | undefined): string {
  const at = clockTime(wait.queued ?? 0);
  if (!at) return wait.detail ?? "";
  const name = wait.check ?? "a check";
  const check = w && wait.check ? checksOf(w).find((c) => c.name === wait.check && c.state === "pending") : undefined;
  if (check?.started) return `${name} running since ${at}`;
  if (check) return `${name} queued at ${at}, no runner since`;
  return `${name} stuck since ${at}`;
}

/** The muted line under a wait's word: why it waits, or "" with nothing
 * to say. A stop says how it stopped, stuck CI which check since when, and
 * failed CI, a merge-ready change or a park the core's own few words. */
export function waitDetail(wait: SavedWait, w: Workspace | undefined): string {
  if (wait.kind === "stopped") return STOP_DETAIL[wait.detail ?? ""] ?? wait.detail ?? "";
  if (wait.kind === "ci_stuck") return stuckDetail(wait, w);
  return wait.detail ?? "";
}

/** A wait in one line, "CI stuck: build queued at 11:20, no runner since";
 * its word alone with nothing more to say. */
export function waitLine(wait: SavedWait, w: Workspace | undefined): string {
  const detail = waitDetail(wait, w);
  return detail ? `${WAIT_WORD[wait.kind]}: ${detail}` : WAIT_WORD[wait.kind];
}
