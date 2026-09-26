// Claude Code PreToolUse hook for Edit, Write and NotebookEdit. Blocks the
// two files CLAUDE.md says agents must never touch, in any checkout of this
// repo, so the rule holds without relying on the agent remembering it.
// Exit 2 tells Claude Code to refuse the call and show the reason. Any
// other exit lets the call through, so every failure here exits 2 too: a
// guard that crashes must not fail open.

import { readFileSync } from "node:fs";
import { relative } from "node:path";
import { checkoutRoot } from "./checkout.ts";

// Case-insensitive because APFS is: Sidebars/Cockpit.JS is the same file.
const RULES: readonly { pattern: RegExp; reason: string }[] = [
  {
    pattern: /^sidebars\/[^/]+\.js$/i,
    reason: "sidebars/*.js is build output: edit src/ and run `npm run build`.",
  },
  {
    pattern: /^config\/projects\.json$/i,
    reason: "config/projects.json is the private project table: edit config/projects.example.json instead.",
  },
];

export function blockReason(filePath: string): string | null {
  const root = checkoutRoot(filePath);
  if (!root) return null;
  const rel = relative(root, filePath);
  return RULES.find((r) => r.pattern.test(rel))?.reason ?? null;
}

function toolPath(input: unknown): unknown {
  if (typeof input !== "object" || input === null || !("tool_input" in input)) return null;
  const t = input.tool_input;
  if (typeof t !== "object" || t === null) return null;
  return "file_path" in t ? t.file_path : "notebook_path" in t ? t.notebook_path : null;
}

function main(): number {
  try {
    const path = toolPath(JSON.parse(readFileSync(0, "utf8")));
    if (typeof path !== "string") return 0;
    const reason = blockReason(path);
    if (!reason) return 0;
    console.error(`Blocked by scripts/hooks/guard-edit.ts: ${reason}`);
  } catch (err) {
    console.error(`Blocked: scripts/hooks/guard-edit.ts failed, so the edit is refused. ${String(err)}`);
  }
  return 2;
}

if (import.meta.main) process.exit(main());
