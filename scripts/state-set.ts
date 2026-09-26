// The URL handler entry (docs/state-loop.md):
//   node scripts/state-set.ts '<url>'
// Parses the URL, applies the set to config/state.json, and rebuilds the
// sidebars so the change takes effect. Any web page can open this URL, so
// this stays a thin wrapper: the pure parsing and file work live in
// state-url.ts, and URL content never reaches a shell (spawnSync with an
// argument array, no shell: true).

import { spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseSetUrl, readApplyWrite } from "./state-url.ts";

const LOG_PATH = join(homedir(), "Library", "Logs", "cmux-cockpit-state.log");

// Logging is best-effort: a missing Logs directory should not fail the handler.
function log(line: string): void {
  try {
    appendFileSync(LOG_PATH, `${new Date().toISOString()} ${line}\n`);
  } catch {
    // ignored
  }
}

function main(): number {
  const raw = process.argv[2];
  if (!raw) {
    log("refused: no URL given key=-");
    return 1;
  }
  const parsed = parseSetUrl(raw);
  if (!parsed.ok) {
    log(`refused: ${parsed.error} key=-`);
    return 1;
  }

  const root = join(import.meta.dirname, "..");
  const stateFile = join(root, "config", "state.json");
  const applied = readApplyWrite(stateFile, parsed.key, parsed.value);
  if (!applied.ok) {
    log(`refused: ${applied.error} key=${parsed.key}`);
    return 1;
  }

  const build = spawnSync(process.execPath, ["scripts/build.ts"], { cwd: root, stdio: "inherit" });
  if (build.status !== 0) {
    log(`error: build failed key=${parsed.key}`);
    return 1;
  }

  log(`ok key=${parsed.key}`);
  return 0;
}

if (import.meta.main) process.exit(main());
