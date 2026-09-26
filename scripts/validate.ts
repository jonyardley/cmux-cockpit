// Runs `cmux sidebar validate`, but only where it means something.
//
// cmux always validates ~/.config/cmux/sidebars (it ignores HOME and
// XDG_CONFIG_HOME, tested 2026-09-25), so from a worktree it would check
// main's files and pass whatever the edit did. Anywhere but the main
// checkout this skips with a note; the built.test.ts smoke test is the
// check that runs everywhere. Without cmux on PATH (CI) it also skips.

import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

interface Report {
  directory: string;
  error_count: number;
  sidebars: { name: string; ok: boolean; error: string | null }[];
}

function real(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

function main(): number {
  const mine = real(join(process.cwd(), "sidebars"));
  const live = real(join(homedir(), ".config", "cmux", "sidebars"));
  if (!mine || mine !== live) {
    console.log("validate: skipped, not the main checkout (cmux only reads ~/.config/cmux/sidebars)");
    return 0;
  }
  const res = spawnSync("cmux", ["sidebar", "validate", "--json"], { encoding: "utf8" });
  if (res.error) {
    console.log("validate: skipped, cmux is not on PATH");
    return 0;
  }
  let report: Report;
  try {
    // The shape `cmux sidebar validate --json` printed on 2026-09-25.
    report = JSON.parse(res.stdout) as Report;
  } catch {
    console.error("validate: unreadable cmux output\n" + res.stdout + res.stderr);
    return 1;
  }
  for (const s of report.sidebars) console.log(`${s.ok ? "ok  " : "FAIL"} ${s.name}${s.error ? ": " + s.error : ""}`);
  return report.error_count > 0 ? 1 : 0;
}

process.exit(main());
