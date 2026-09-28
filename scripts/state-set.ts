// The URL handler entry (docs/state-loop.md):
//   node scripts/state-set.ts '<url>'
// Parses the URL, applies the set to config/state.json, and rebuilds the
// sidebars so the change takes effect (except a `ui` set, which the sidebar
// already shows; see rebuildsOn). Any web page can open this URL, so
// this stays a thin wrapper: the pure parsing and file work live in
// state-url.ts, and URL content never reaches a shell (spawnSync with an
// argument array, no shell: true). The log names the key JSON-quoted, so a
// newline in it cannot forge a line, and never the value.

import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { rebuildsOn, urlMaySet } from "./state-config.ts";
import { logLine as log } from "./state-log.ts";
import { parseSetUrl, readApplyWrite } from "./state-url.ts";

function main(): number {
  const raw = process.argv[2];
  if (!raw) {
    log("refused: no URL given");
    return 1;
  }
  const parsed = parseSetUrl(raw);
  if (!parsed.ok) {
    log(`refused: ${parsed.error}`);
    return 1;
  }

  // A hook-only map (an agent's ask, issue #81) is never set from a URL.
  if (!urlMaySet(parsed.key)) {
    log(`refused: not settable by URL key=${JSON.stringify(parsed.key)}`);
    return 1;
  }

  const root = join(import.meta.dirname, "..");
  const stateFile = join(root, "config", "state.json");
  const key = JSON.stringify(parsed.key);
  let applied: ReturnType<typeof readApplyWrite>;
  try {
    applied = readApplyWrite(stateFile, parsed.key, parsed.value);
  } catch (err) {
    log(`error: write failed (${err instanceof Error ? err.message : String(err)}) key=${key}`);
    return 1;
  }
  if (!applied.ok) {
    log(`refused: ${applied.error} key=${key}`);
    return 1;
  }
  if (!applied.changed) {
    log(`ok, unchanged key=${key}`);
    return 0;
  }

  if (!rebuildsOn(parsed.key)) {
    log(`ok, kept for the next build key=${key}`);
    return 0;
  }

  const build = spawnSync(process.execPath, ["scripts/build.ts"], { cwd: root, stdio: "inherit" });
  if (build.status !== 0) {
    log(`error: build failed key=${key}`);
    return 1;
  }

  log(`ok key=${key}`);
  return 0;
}

if (import.meta.main) process.exit(main());
