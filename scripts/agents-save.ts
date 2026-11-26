// Saves the agents each workspace shows, as the native core shows them, in
// config/state.json's `agents` map (#429), so the agents panel reads each
// agent's status and why it waits on Jon from the core's rules. The core is
// the one writer.
//   node scripts/agents-save.ts '<json>'
// The JSON is the core's SaveAgents effect's `agents`: workspace id to a
// list to set, or null to delete. Each list is cleaned by the state file's
// own contract (validateState) first, so one the contract refuses is
// skipped rather than deleting what the file holds. The write is the
// locked atomic read-modify-write every state write uses, and only a
// write that changed the file schedules the sidebars' rebuild. The log
// names counts only.

import { join } from "node:path";
import { scheduleBuild } from "./hook-build.ts";
import { isRecord, type SavedAgent, validateState } from "./state-config.ts";
import { logLine } from "./state-log.ts";
import { writeAgentsEntries } from "./state-url.ts";

function log(line: string): void {
  logLine(`agents-save ${line}`);
}

/** What to write: the clean lists to set and the ids to delete, or why not. */
export type AgentsSaveInput =
  | { ok: true; set: Record<string, SavedAgent[]>; remove: string[]; skipped: number }
  | { ok: false; error: string };

/** Reads the effect's JSON: a map of workspace id to a list or null. */
export function parseAgentsSave(text: string | undefined): AgentsSaveInput {
  let raw: unknown;
  try {
    raw = JSON.parse(text ?? "");
  } catch {
    return { ok: false, error: "not JSON" };
  }
  if (!isRecord(raw)) return { ok: false, error: "not a map" };
  const remove = Object.keys(raw).filter((id) => raw[id] === null);
  const given = Object.fromEntries(Object.entries(raw).filter(([, v]) => v !== null));
  const set = validateState({ agents: given }).agents ?? {};
  const skipped = Object.keys(given).length - Object.keys(set).length;
  return { ok: true, set, remove, skipped };
}

function main(): number {
  const input = parseAgentsSave(process.argv[2]);
  if (!input.ok) {
    log(`refused: ${input.error}`);
    return 1;
  }
  const stateFile = join(import.meta.dirname, "..", "config", "state.json");
  const counts = `${Object.keys(input.set).length} set, ${input.remove.length} removed${input.skipped ? `, ${input.skipped} refused` : ""}`;
  try {
    const applied = writeAgentsEntries(stateFile, input.set, input.remove);
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
  scheduleBuild("agents-save", "soon");
  log(`ok, ${counts}`);
  return 0;
}

if (import.meta.main) process.exitCode = main();
