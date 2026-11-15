// Keeps the real project table out of the tree. config/projects.json is
// gitignored, but its names can still leak into fixtures or docs; this
// fails if any tracked file mentions one. It bites where it matters: in
// the pre-commit hook, against the real table. In CI the table is a copy
// of the sample, whose placeholder names are excluded, so it passes there.
// Entries for this repo itself (cmux, cockpit) are skipped, since the
// tree names itself everywhere.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { basename } from "node:path";
import { it } from "node:test";

const SELF = "cmux-cockpit";
const SKIP = new Set(["config/projects.example.json", "package-lock.json"]);

function termsOf(entry: unknown): string[] {
  if (typeof entry !== "object" || entry === null) return [];
  const values = ["match", "name"].map((k) => (k in entry ? Reflect.get(entry, k) : null));
  return values
    .map((v) => (typeof v === "string" ? basename(v).toLowerCase() : ""))
    .filter((t) => t.length >= 4 && !SELF.includes(t));
}

function tableTerms(path: string): string[] {
  if (!existsSync(path)) return [];
  const table: unknown = JSON.parse(readFileSync(path, "utf8"));
  return Array.isArray(table) ? table.flatMap(termsOf) : [];
}

// The sample's placeholders are what the fixtures use, so they never count.
function privateTerms(): string[] {
  const sample = new Set(tableTerms("config/projects.example.json"));
  return [...new Set(tableTerms("config/projects.json"))].filter((t) => !sample.has(t));
}

it("no tracked file names a project from config/projects.json", () => {
  const terms = privateTerms();
  const files = execFileSync("git", ["ls-files"], { encoding: "utf8" })
    .split("\n")
    .filter((f) => f && !SKIP.has(f));
  const hits: string[] = [];
  for (const f of files) {
    if (!existsSync(f)) continue;
    const text = readFileSync(f, "utf8").toLowerCase();
    const n = terms.filter((t) => text.includes(t)).length;
    if (n) hits.push(`${f} (${n} term${n === 1 ? "" : "s"})`);
  }
  // Report counts, not the terms, so the failure itself does not leak them.
  assert.deepEqual(hits, [], `tracked files mention real project names: ${hits.join(", ")}`);
});
