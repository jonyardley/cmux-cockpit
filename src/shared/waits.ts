// The Cockpit's waits on Jon, read from the saved state (#388): a stopped
// session, CI stuck or failed with nobody on it, a change left merge-ready
// four hours, parked Ostinato attempts. The native core alone decides
// them and saves what its cards show (native/core/src/waits_save.rs, the
// saved `waits` map), so the agents panel names and counts the same waits
// rather than rules of its own.
//
// A saved wait lands on the workspace's agents in the core's order
// (`Session::agents_of` in native/core/src/needs.rs): a stop on its own
// session whatever it reads; then the CI wait on the most active agent,
// only once it has finished (ci_wait.rs `with_ci`); then the park on the
// most active agent not already waiting on Jon (ostinato/wait.rs
// `park_carrier`). With no agent left, one stand-in carries the CI wait,
// else the park. So a wait on an agent the panel already reads as
// needs_input never counts twice.
//
// Dismissing stays in the Cockpit: its dismissal clears the saved wait,
// and the next build bakes the map without it.

import type { SavedWait, WaitKind } from "../../scripts/state-config.ts";
import { mostActive } from "./activity.ts";
import { SAVED_STATE } from "./persist.ts";
import { checksOf } from "./prs.ts";
import { WAIT_WORD } from "./words.ts";

/** `wsId`'s saved waits, in the core's order (stops, CI, park); none
 * without any, or from a state file older than the map. */
export function waitsFor(wsId: string): SavedWait[] {
  const map: Record<string, SavedWait[]> | undefined = SAVED_STATE.waits;
  return (map && Object.hasOwn(map, wsId) ? map[wsId] : undefined) ?? [];
}

const isCi = (k: WaitKind): boolean => k === "ci_stuck" || k === "ci_failing" || k === "merge_ready";
const finished = (a: Agent): boolean => a.status === "idle" || a.status === "ended";

/** A workspace's agents with its saved waits laid on them, as the core lays them. */
export interface Waited {
  /** The agents as given, each carrying a wait reading needs_input from its start. */
  agents: Agent[];
  /** Whether a stand-in carries a wait, with no agent left to. */
  standIn: boolean;
  /** The waits that landed, in the saved order: what the card shows. */
  shown: SavedWait[];
  /** Of those, the ones that made an agent (or the stand-in) wait on Jon
   * that the panel did not already read as needs_input. */
  added: SavedWait[];
}

// `a` carrying `wait`: needs_input from the wait's start.
const carrying = (a: Agent, wait: SavedWait): Agent => ({ ...a, status: "needs_input", sinceEpoch: wait.since });

// The workspace's stops on `agents`, each on its own session by id.
function withStops(agents: Agent[], waits: readonly SavedWait[], out: Waited): Agent[] {
  return agents.map((a) => {
    const stop = waits.find((v) => v.kind === "stopped" && v.agent === a.id);
    if (!stop) return a;
    out.shown.push(stop);
    if (a.status !== "needs_input") out.added.push(stop);
    return carrying(a, stop);
  });
}

// `agents` with `wait` on the one `carries` picks, if any.
function onCarrier(agents: Agent[], wait: SavedWait | undefined, carries: (a: Agent) => boolean, out: Waited): Agent[] {
  const lead = mostActive(agents);
  if (!wait || !lead || !carries(lead)) return agents;
  out.shown.push(wait);
  out.added.push(wait);
  return agents.map((a) => (a === lead ? carrying(a, wait) : a));
}

/**
 * `agents`, a workspace's as the panel reads them (agentsOf), with `waits`,
 * its saved ones, laid on in the core's order. Pure, so each rule is
 * testable alone.
 */
export function withWaits(agents: Agent[], waits: readonly SavedWait[]): Waited {
  const out: Waited = { agents, standIn: false, shown: [], added: [] };
  const ci = waits.find((v) => isCi(v.kind));
  const park = waits.find((v) => v.kind === "park");
  if (!agents.length) {
    const stand = ci ?? park;
    if (stand) {
      out.standIn = true;
      out.shown.push(stand);
      out.added.push(stand);
    }
    return out;
  }
  const stopped = withStops(agents, waits, out);
  const ciDone = onCarrier(stopped, ci, finished, out);
  out.agents = onCarrier(ciDone, park, (a) => a.status !== "needs_input", out);
  return out;
}

// ---- Words ------------------------------------------------------------------

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
// copy of the check, found by name, tells them apart.
function stuckDetail(wait: SavedWait, w: Workspace | undefined): string {
  const at = clockTime(wait.queued ?? 0);
  if (!at) return wait.detail ?? "";
  const name = wait.check ?? "a check";
  const check = w && wait.check ? checksOf(w).find((c) => c.name === wait.check) : undefined;
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
