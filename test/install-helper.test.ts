// The helper app's filled AppleScript (scripts/install-helper.ts), and the
// URL handler's token gate (scripts/state-set.ts) the app hands every tap
// to. Compiling the app needs osacompile, so only the fill is checked here.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { filledScript } from "../scripts/install-helper.ts";

const ROOT = join(import.meta.dirname, "..");

describe("the helper's AppleScript", () => {
  const script = filledScript(ROOT);

  it("fills every placeholder", () => {
    assert.doesNotMatch(script, /__[A-Z]+__/);
  });

  it("bakes in no node path, finding node at tap time instead", () => {
    assert.equal(script.includes(process.execPath), false);
    assert.ok(script.includes(`"${ROOT}"`));
    assert.match(script, /set finderPath to repoRoot & "\/scripts\/find-node\.sh"/);
    assert.match(script, /do shell script "\/bin\/sh " & \(quoted form of finderPath\)/);
  });

  it("passes the URL to the shell only through quoted form of", () => {
    const code = script
      .split("\n")
      .filter((line) => !line.trim().startsWith("--"))
      .join("\n");
    const uses = code.match(/theURL/g) ?? [];
    const quoted = code.match(/\(quoted form of theURL\)/g) ?? [];
    // One in the handler's signature, the rest quoted.
    assert.equal(uses.length, quoted.length + 1);
    assert.ok(quoted.length >= 1);
  });
});

describe("state-set.ts refuses a set without this install's token", () => {
  // HOME points at a temp dir so the refusal lands in a log the test can
  // read, never the real one. Refused before the state file is touched.
  function refusal(url: string): { status: number | null; log: string } {
    const home = mkdtempSync(join(tmpdir(), "state-set-"));
    try {
      mkdirSync(join(home, "Library", "Logs"), { recursive: true });
      const r = spawnSync(process.execPath, [join(ROOT, "scripts", "state-set.ts"), url], {
        env: { ...process.env, HOME: home },
      });
      return { status: r.status, log: readFileSync(join(home, "Library", "Logs", "cmux-cockpit-state.log"), "utf8") };
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }

  it("refuses a set with no token", () => {
    const { status, log } = refusal("cmux-cockpit://set?key=ui.mode&value=%22all%22");
    assert.equal(status, 1);
    assert.match(log, / refused: bad token\n$/);
  });

  it("refuses a wrong token without writing it to the log", () => {
    const forged = "f".repeat(64);
    const { status, log } = refusal(`cmux-cockpit://set?key=ui.mode&value=%22all%22&token=${forged}`);
    assert.equal(status, 1);
    assert.match(log, / refused: bad token\n$/);
    assert.equal(log.includes(forged), false);
  });
});
