// Saves the native core's background verdicts in config/state.json's
// `running` map (#360), so the agents panel, which reads only the file,
// says Running when the card does. The core is the one writer of the map.
//   node scripts/running-save.ts '<json>'
// The JSON is the core's SaveRunning effect's `running`: workspace id to
// a verdict to set, or null to delete. Each verdict is cleaned by the
// state file's own contract (validateState) first, so one the contract
// refuses is skipped rather than deleting what the file holds. The write
// is the locked atomic read-modify-write every state write uses, and only
// a write that changed the file schedules the sidebars' rebuild
// (hook-build.ts's coalesced one, detached), so this returns at once. The
// log names counts only.

import { join } from "node:path";
import { scheduleBuild } from "./hook-build.ts";
import { isRecord, type SavedRunning, validateState } from "./state-config.ts";
import { logLine } from "./state-log.ts";
import { writeRunningEntries } from "./state-url.ts";

function log(line: string): void {
  logLine(`running-save ${line}`);
}

/** What to write: the clean verdicts to set and the ids to delete, or why not. */
export type RunningSaveInput =
  | { ok: true; set: Record<string, SavedRunning>; remove: string[]; skipped: number }
  | { ok: false; error: string };

/** Reads the effect's JSON: a map of workspace id to a verdict or null. */
export function parseRunningSave(text: string | undefined): RunningSaveInput {
  let raw: unknown;
  try {
    raw = JSON.parse(text ?? "");
  } catch {
    return { ok: false, error: "not JSON" };
  }
  if (!isRecord(raw)) return { ok: false, error: "not a map" };
  const remove = Object.keys(raw).filter((id) => raw[id] === null);
  const given = Object.fromEntries(Object.entries(raw).filter(([, v]) => v !== null));
  const set = validateState({ running: given }).running ?? {};
  const skipped = Object.keys(given).length - Object.keys(set).length;
  return { ok: true, set, remove, skipped };
}

function main(): number {
  const input = parseRunningSave(process.argv[2]);
  if (!input.ok) {
    log(`refused: ${input.error}`);
    return 1;
  }
  const stateFile = join(import.meta.dirname, "..", "config", "state.json");
  const counts = `${Object.keys(input.set).length} set, ${input.remove.length} removed${input.skipped ? `, ${input.skipped} refused` : ""}`;
  try {
    const applied = writeRunningEntries(stateFile, input.set, input.remove);
    if (!applied.ok) {
      log(`refused: ${applied.error}`);
      return 1;
    }
    if (!applied.changed) {
      log(`ok, unchanged (${counts})`);
      return 0;
    }
  } catch (err) {
    log(`error: write failed (${err instanceof Error ? err.message : String(err)})`);
    return 1;
  }
  scheduleBuild("running-save", "soon");
  log(`ok, ${counts}`);
  return 0;
}

if (import.meta.main) process.exitCode = main();
