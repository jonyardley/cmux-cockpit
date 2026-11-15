// The pull request size check: added lines against the base, leaving out
// lock files, fixtures, snapshots and generated files, fail over LIMIT
// unless the description's "## Size" section says why. The limit and the
// section are set in ~/.claude/CLAUDE.md ("Speed and reliability").

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { eventBody, fetchBody, filled } from "./pr-body.ts";

export const LIMIT = 800;

// Pathspecs for what is not counted. Lock files and snapshots are
// generated; fixtures and golden answers are data the tests read.
export const EXCLUDE = [
  "**/*.lock",
  "**/package-lock.json",
  "**/fixtures/**",
  "**/snapshots/**",
  "**/__snapshots__/**",
  "test/golden/**",
  "**/generated/**",
].map((p) => `:(exclude,glob)${p}`);

// Total added lines in `git diff --numstat` output. Binary files show "-".
export function added(numstat: string): number {
  return numstat
    .split("\n")
    .map((l) => Number.parseInt(l.split("\t")[0] ?? "", 10))
    .reduce((sum, n) => sum + (Number.isNaN(n) ? 0 : n), 0);
}

// The message to fail with, or null to pass. `body` is only read when over.
export function sizeMessage(lines: number, body: () => string): string | null {
  if (lines <= LIMIT || filled(body(), "Size")) return null;
  return `pr-size: ${lines} added lines is over ${LIMIT}. Split the PR, or say why in a "## Size" section of the description.`;
}

// In CI it diffs the merge commit against its first parent, the base, and
// reads the event. By hand (`npm run pr-size`) it diffs the working tree
// against where it left origin/main, and reads the live description only
// when over.
function main(): number {
  const ci = process.env.GITHUB_EVENT_PATH;
  const range = ci ? ["HEAD^1", "HEAD"] : ["--merge-base", "origin/main"];
  const r = spawnSync("git", ["diff", "--numstat", ...range, "--", ".", ...EXCLUDE], { encoding: "utf8" });
  if (r.status !== 0) {
    console.error(`pr-size: git diff failed. ${r.stderr.trim()}`);
    return 1;
  }
  const lines = added(r.stdout);
  const body = (): string => {
    if (ci) return eventBody(JSON.parse(readFileSync(ci, "utf8")));
    const b = fetchBody(null);
    return b instanceof Error ? "" : b;
  };
  const message = sizeMessage(lines, body);
  if (message) console.error(message);
  else console.log(`pr-size: ${lines} added lines counted, limit ${LIMIT}.`);
  return message ? 1 : 0;
}

if (import.meta.main) process.exit(main());
