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

// The message to fail with, or null to pass. `body` is only read when over;
// an Error from it is reported as such, not read as an empty description.
export function sizeMessage(lines: number, body: () => string | Error): string | null {
  if (lines <= LIMIT) return null;
  const b = body();
  if (b instanceof Error) {
    return `pr-size: ${lines} added lines is over ${LIMIT}, and the description could not be read to look for a "## Size" section. ${b.message}`;
  }
  if (filled(b, "Size")) return null;
  return `pr-size: ${lines} added lines is over ${LIMIT}. Split the PR, or say why in a "## Size" section of the description.`;
}

// What to diff against. In CI the merge commit's first parent is the tip of
// the PR's own base branch, so a stacked PR is measured against its parent
// PR. By hand it is where the working tree left `base`, origin/main unless
// given; the local count is a hint (untracked files are not counted and
// nothing is fetched), CI is the authority.
export function diffRange(ci: boolean, base?: string): string[] {
  return ci ? ["HEAD^1", "HEAD"] : ["--merge-base", base ?? "origin/main"];
}

// The description from the event file GitHub hands the job, or an Error
// saying why it could not be read.
function ciBody(path: string): string | Error {
  try {
    return eventBody(JSON.parse(readFileSync(path, "utf8")));
  } catch (e) {
    return new Error(`Could not read the event file ${path}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// In CI it reads the event. By hand (`npm run pr-size [-- <base>]`) it
// reads the live description, and only when over.
function main(): number {
  const ci = process.env.GITHUB_EVENT_PATH;
  const range = diffRange(Boolean(ci), process.argv[2]);
  const r = spawnSync("git", ["diff", "--numstat", ...range, "--", ".", ...EXCLUDE], { encoding: "utf8" });
  if (r.status !== 0) {
    console.error(`pr-size: git diff failed. ${r.stderr.trim()}`);
    return 1;
  }
  const lines = added(r.stdout);
  const body = (): string | Error => (ci ? ciBody(ci) : fetchBody(null));
  const message = sizeMessage(lines, body);
  if (message) console.error(message);
  else console.log(`pr-size: ${lines} added lines counted, limit ${LIMIT}.`);
  return message ? 1 : 0;
}

if (import.meta.main) process.exit(main());
