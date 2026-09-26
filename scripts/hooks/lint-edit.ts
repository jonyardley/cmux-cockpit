// Claude Code PostToolUse hook for Edit and Write. Runs the checkout's own
// Biome on the file just changed, with the same --error-on-warnings as
// `npm run lint`, so the agent sees problems at once rather than at commit.
// Exit 2 hands Biome's output back to the agent; it never edits. Files in
// other repos, and checkouts without node_modules yet, are skipped.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { checkoutRoot } from "./checkout.ts";

function editedPath(input: unknown): unknown {
  if (typeof input !== "object" || input === null || !("tool_input" in input)) return null;
  const t = input.tool_input;
  return typeof t === "object" && t !== null && "file_path" in t ? t.file_path : null;
}

function main(): number {
  const path = editedPath(JSON.parse(readFileSync(0, "utf8")));
  if (typeof path !== "string" || !/\.(ts|json)$/.test(path)) return 0;
  const root = checkoutRoot(path);
  const biome = root && join(root, "node_modules", ".bin", "biome");
  if (!root || !biome || !existsSync(biome)) return 0;
  const res = spawnSync(biome, ["check", "--error-on-warnings", "--colors=off", "--no-errors-on-unmatched", path], {
    cwd: root,
    encoding: "utf8",
  });
  if (res.error || res.status === 0) return 0;
  console.error(`Biome found problems in ${path} (fix with \`npm run fix\`):\n${res.stdout}${res.stderr}`);
  return 2;
}

if (import.meta.main) process.exit(main());
