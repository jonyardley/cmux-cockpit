// Saves the native core's waits on Jon in config/state.json's `waits` map
// (#388), so the agents panel, which reads only the file, counts and
// names the waits the Cockpit's card shows. The core is the one writer.
//   node scripts/waits-save.ts '<json>'
// The JSON is the core's SaveWaits effect's `waits`: workspace id to the
// card's waits to set, or null to delete. Each list is cleaned by the
// state file's own contract (validateState) first, so one the contract
// refuses is skipped rather than deleting what the file holds. The write
// is the locked atomic read-modify-write every state write uses, and only
// a write that changed the file schedules the sidebars' rebuild
// (hook-build.ts's coalesced one, detached), so this returns at once. The
// log names counts only.

import { join } from "node:path";
import { scheduleBuild } from "./hook-build.ts";
import { isRecord, type SavedWait, validateState } from "./state-config.ts";
import { logLine } from "./state-log.ts";
import { writeWaitEntries } from "./state-url.ts";

function log(line: string): void {
  logLine(`waits-save ${line}`);
}

/** What to write: the clean waits to set and the ids to delete, or why not. */
export type WaitsSaveInput =
  | { ok: true; set: Record<string, SavedWait[]>; remove: string[]; skipped: number }
  | { ok: false; error: string };

/** Reads the effect's JSON: a map of workspace id to a list of waits or null. */
export function parseWaitsSave(text: string | undefined): WaitsSaveInput {
  let raw: unknown;
  try {
    raw = JSON.parse(text ?? "");
  } catch {
    return { ok: false, error: "not JSON" };
  }
  if (!isRecord(raw)) return { ok: false, error: "not a map" };
  const remove = Object.keys(raw).filter((id) => raw[id] === null);
  const given = Object.fromEntries(Object.entries(raw).filter(([, v]) => v !== null));
  const set = validateState({ waits: given }).waits ?? {};
  const skipped = Object.keys(given).length - Object.keys(set).length;
  return { ok: true, set, remove, skipped };
}

function main(): number {
  const input = parseWaitsSave(process.argv[2]);
  if (!input.ok) {
    log(`refused: ${input.error}`);
    return 1;
  }
  const stateFile = join(import.meta.dirname, "..", "config", "state.json");
  const counts = `${Object.keys(input.set).length} set, ${input.remove.length} removed${input.skipped ? `, ${input.skipped} refused` : ""}`;
  try {
    const applied = writeWaitEntries(stateFile, input.set, input.remove);
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
  scheduleBuild("waits-save", "soon");
  log(`ok, ${counts}`);
  return 0;
}

if (import.meta.main) process.exitCode = main();
