// Saves the native cockpit's PR poll answers in config/state.json's `prs`
// map (#300), so the agents panel, which reads only the file, says what
// the card says. The native poll is the one writer of `prs` verdicts;
// scripts/pr-poll.ts only drops closed workspaces.
//   node scripts/pr-save.ts '<json>'
// The JSON is the core's SavePrs effect's `prs`: workspace id to a PR to
// set, or null to delete. Each PR is cleaned by the state file's own
// contract (validateState) first, so a field the contract refuses never
// reaches the file, and an entry it refuses entirely is skipped rather
// than deleting what the file holds. The write is the locked atomic
// read-modify-write every state write uses, and only a write that changed
// the file schedules the sidebars' rebuild (hook-build.ts's coalesced
// one, detached), so this returns at once and the runner's queue never
// waits on a build. The log names counts, never a title or URL.

import { join } from "node:path";
import { scheduleBuild } from "./hook-build.ts";
import { isRecord, type State, validateState } from "./state-config.ts";
import { logLine } from "./state-log.ts";
import { writePrEntries } from "./state-url.ts";

function log(line: string): void {
  logLine(`pr-save ${line}`);
}

/** What to write: the clean PRs to set and the ids to delete, or why not. */
export type PrSaveInput =
  | { ok: true; set: State["prs"]; remove: string[]; skipped: number }
  | { ok: false; error: string };

/** Reads the effect's JSON: a map of workspace id to a PR or null. */
export function parsePrSave(text: string | undefined): PrSaveInput {
  let raw: unknown;
  try {
    raw = JSON.parse(text ?? "");
  } catch {
    return { ok: false, error: "not JSON" };
  }
  if (!isRecord(raw)) return { ok: false, error: "not a map" };
  const remove = Object.keys(raw).filter((id) => raw[id] === null);
  const given = Object.fromEntries(Object.entries(raw).filter(([, pr]) => pr !== null));
  const set = validateState({ prs: given }).prs;
  const skipped = Object.keys(given).length - Object.keys(set).length;
  return { ok: true, set, remove, skipped };
}

function main(): number {
  const input = parsePrSave(process.argv[2]);
  if (!input.ok) {
    log(`refused: ${input.error}`);
    return 1;
  }
  const stateFile = join(import.meta.dirname, "..", "config", "state.json");
  const counts = `${Object.keys(input.set).length} set, ${input.remove.length} removed${input.skipped ? `, ${input.skipped} refused` : ""}`;
  try {
    const applied = writePrEntries(stateFile, input.set, input.remove);
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
  scheduleBuild("pr-save", "soon");
  log(`ok, ${counts}`);
  return 0;
}

if (import.meta.main) process.exitCode = main();
