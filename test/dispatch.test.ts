// The one hook entry point: routes.ts picks the scripts an event runs, as
// Claude Code would match them, and dispatch.ts runs each on its own, so a
// script that fails, hangs or never reads its input leaves the rest alone.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { notes, parsePayload, runAll } from "../scripts/hooks/dispatch.ts";
import { matches, ROUTES, scriptsFor } from "../scripts/hooks/routes.ts";

describe("matches", () => {
  it("takes missing, empty and * as everything", () => {
    for (const m of [undefined, "", "*"]) {
      assert.ok(matches(m, "Bash"));
      assert.ok(matches(m, undefined));
    }
  });

  it("matches plain names, alone or joined with |, exactly and case-sensitively", () => {
    assert.ok(matches("Agent", "Agent"));
    assert.ok(!matches("Agent", "SubAgent"), "a plain name is the whole value, not a substring");
    assert.ok(!matches("Agent", "agent"));
    assert.ok(matches("AskUserQuestion|ExitPlanMode", "ExitPlanMode"));
    assert.ok(!matches("AskUserQuestion|ExitPlanMode", "PlanMode"));
    assert.ok(!matches("Bash", undefined));
  });

  it("reads anything else as a regex found anywhere in the value", () => {
    assert.ok(matches("mcp__.*", "mcp__x__y"));
    assert.ok(matches("Claude_Docs__(batch|update)", "mcp__claude_ai_Claude_Docs__batch"));
    assert.ok(!matches("Claude_Docs__(batch|update)", "mcp__claude_ai_Claude_Docs__read"));
  });

  it("matches nothing with a matcher that is not a valid regex", () => {
    assert.ok(!matches("a(", "a("));
    assert.ok(!matches("a(", "a"));
  });
});

describe("scriptsFor", () => {
  it("picks tool events' scripts by tool name", () => {
    assert.deepEqual(scriptsFor("PreToolUse", { tool_name: "Agent" }), ["report-subagent.ts"]);
    assert.deepEqual(scriptsFor("PreToolUse", { tool_name: "ExitPlanMode" }), ["report-notification.ts"]);
    assert.deepEqual(scriptsFor("PreToolUse", { tool_name: "Read" }), []);
    assert.deepEqual(scriptsFor("PostToolUse", { tool_name: "Bash" }), ["report-pr.ts"]);
    assert.deepEqual(scriptsFor("PostToolUse", { tool_name: "mcp__claude_ai_Claude_Docs__update" }), [
      "report-published.ts",
    ]);
  });

  it("picks Notification's by notification type", () => {
    assert.deepEqual(scriptsFor("Notification", { notification_type: "permission_prompt" }), [
      "report-notification.ts",
    ]);
    assert.deepEqual(scriptsFor("Notification", { notification_type: "idle_prompt" }), []);
  });

  it("runs an unmatched route every time, even when the input did not parse", () => {
    assert.deepEqual(scriptsFor("Stop", {}), ["report-move.ts", "report-rename.ts"]);
    assert.deepEqual(scriptsFor("PermissionRequest", { tool_name: "Bash" }), ["report-notification.ts"]);
    assert.deepEqual(scriptsFor("SessionStart", null), ["report-rename.ts"]);
    assert.deepEqual(scriptsFor("PreToolUse", null), []);
  });

  it("runs nothing for an event it has no routes for, and keeps list order", () => {
    assert.deepEqual(scriptsFor("SessionEnd", { reason: "exit" }), []);
    const routes = { PostToolUse: [{ script: "b.ts", matcher: "Bash" }, { script: "a.ts" }, { script: "c.ts" }] };
    assert.deepEqual(scriptsFor("PostToolUse", { tool_name: "Bash" }, routes), ["b.ts", "a.ts", "c.ts"]);
    assert.deepEqual(scriptsFor("PostToolUse", { tool_name: 3 }, routes), ["a.ts", "c.ts"]);
  });

  it("covers every event the entry points are installed for", () => {
    for (const [event, routes] of Object.entries(ROUTES)) assert.ok(routes.length > 0, event);
  });
});

describe("parsePayload", () => {
  it("returns an object, or null for anything else", () => {
    assert.deepEqual(parsePayload('{"tool_name":"Bash"}'), { tool_name: "Bash" });
    for (const bad of ["", "nope", "[1]", "null", "3"]) assert.equal(parsePayload(bad), null, bad);
  });
});

describe("runAll", () => {
  const dir = mkdtempSync(join(tmpdir(), "dispatch-"));
  after(() => rmSync(dir, { recursive: true, force: true }));
  const script = (name: string, body: string): string => {
    writeFileSync(join(dir, name), body);
    return name;
  };
  const copy = script(
    "copy.ts",
    `import { readFileSync, writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(join(dir, "got.json"))}, readFileSync(0, "utf8"));
console.log("stdout that must go nowhere");`,
  );
  const fails = script("fails.ts", `console.error("it broke\\nsecond line"); process.exit(3);`);
  const throws = script("throws.ts", `throw new Error("boom");`);
  const hangs = script("hangs.ts", `setInterval(() => {}, 1000);`);
  const deaf = script("deaf.ts", `process.exit(0);`);
  const parent = script(
    "parent.ts",
    `import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
const child = spawn("sleep", ["30"], { stdio: "ignore" });
writeFileSync(${JSON.stringify(join(dir, "grandchild.pid"))}, String(child.pid));
setInterval(() => {}, 1000);`,
  );
  const alive = (pid: number): boolean => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  it("hands each script the same input, and one failing, throwing or hanging never stops the others", async () => {
    const input = JSON.stringify({ tool_name: "Bash", big: "x".repeat(200_000) });
    const started = Date.now();
    const ran = await runAll(dir, [fails, throws, hangs, deaf, copy], input, 1500);
    assert.ok(Date.now() - started < 5000, "the hung script is stopped at its limit");
    assert.equal(readFileSync(join(dir, "got.json"), "utf8"), input);
    const by = new Map(ran.map((r) => [r.script, r]));
    assert.equal(by.get(copy)?.status, 0);
    assert.equal(by.get(copy)?.stderr, "");
    assert.equal(by.get(fails)?.status, 3);
    assert.notEqual(by.get(throws)?.status, 0);
    assert.equal(by.get(hangs)?.timedOut, true);
    assert.equal(by.get(deaf)?.status, 0);
  });

  it("ends what a script started when it runs out of time, not just the script", async () => {
    const [r] = await runAll(dir, [parent], "{}", 1500);
    assert.equal(r?.timedOut, true);
    const pid = Number(readFileSync(join(dir, "grandchild.pid"), "utf8"));
    await new Promise((done) => setTimeout(done, 200));
    assert.equal(alive(pid), false, "the grandchild's sleep was killed with its group");
  });

  it("reports a script that is not there without throwing", async () => {
    const [r] = await runAll(dir, ["missing.ts"], "{}", 5000);
    assert.notEqual(r?.status, 0);
  });

  it("tags each stderr line with its script, and names a silent failure or a timeout", () => {
    const base = { script: "x.ts", status: 0, timedOut: false, limitMs: 30_000, stderr: "" };
    assert.deepEqual(notes(base), []);
    assert.deepEqual(notes({ ...base, status: 1, stderr: "a\n\nb\n" }), ["dispatch x.ts: a", "dispatch x.ts: b"]);
    assert.deepEqual(notes({ ...base, status: 2 }), ["dispatch x.ts: exited 2"]);
    assert.deepEqual(notes({ ...base, status: null }), ["dispatch x.ts: exited on a signal"]);
    assert.deepEqual(notes({ ...base, status: null, timedOut: true }), ["dispatch x.ts: stopped after 30s"]);
    const short = { ...base, status: null, timedOut: true, limitMs: 1500 };
    assert.deepEqual(notes(short), ["dispatch x.ts: stopped after 1.5s"]);
  });
});

describe("dispatch.ts as Claude Code runs it", () => {
  const run = (args: string[], input: string) =>
    spawnSync(process.execPath, ["scripts/hooks/dispatch.ts", ...args], { input, encoding: "utf8" });

  it("exits 0 with nothing on stdout, for an event with no routes, bad input or no event at all", () => {
    for (const [args, input] of [
      [["SessionEnd"], '{"reason":"exit"}'],
      [["PreToolUse"], "not json"],
      [[], ""],
      [["PreToolUse"], '{"tool_name":"Read"}'],
    ] as const) {
      const r = run([...args], input);
      assert.equal(r.status, 0, JSON.stringify(args));
      assert.equal(r.stdout, "");
    }
  });
});
