// The Claude Code edit guard: the two never-edit paths are blocked in any
// checkout of this repo, whatever the case, and nothing else is. The
// script itself exits 2 to block, including when it cannot read its input.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { blockReason } from "../scripts/hooks/guard-edit.ts";

function checkout(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), "guard-"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name }));
  mkdirSync(join(dir, "sidebars"));
  return dir;
}

const ours = checkout("cmux-cockpit");
const other = checkout("something-else");

function runGuard(stdin: string): number | null {
  return spawnSync(process.execPath, ["scripts/hooks/guard-edit.ts"], { input: stdin }).status;
}

describe("guard-edit", () => {
  it("blocks built sidebars and the private project table", () => {
    assert.match(blockReason(join(ours, "sidebars/cockpit.js")) ?? "", /build output/);
    assert.match(blockReason(join(ours, "config/projects.json")) ?? "", /private project table/);
  });

  it("blocks them whatever the case, since APFS ignores it", () => {
    assert.notEqual(blockReason(join(ours, "Sidebars/Cockpit.JS")), null);
    assert.notEqual(blockReason(join(ours, "config/Projects.json")), null);
  });

  it("allows sources, the sample table, parked Swift and nested paths", () => {
    for (const p of [
      "src/cockpit/model.ts",
      "config/projects.example.json",
      "sidebars/board.swift.parked",
      "sidebars/nested/x.js",
    ]) {
      assert.equal(blockReason(join(ours, p)), null, p);
    }
  });

  it("leaves other repos alone", () => {
    assert.equal(blockReason(join(other, "config/projects.json")), null);
    assert.equal(blockReason(join(tmpdir(), "no-package-here", "sidebars/x.js")), null);
  });

  it("exits 2 to block, 0 to allow, and 2 when its input is unreadable", () => {
    const payload = (p: string) => JSON.stringify({ tool_input: { file_path: join(ours, p) } });
    assert.equal(runGuard(payload("sidebars/cockpit.js")), 2);
    assert.equal(runGuard(payload("src/x.ts")), 0);
    assert.equal(runGuard("not json"), 2);
  });
});
