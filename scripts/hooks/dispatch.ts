// The one Claude Code hook the cockpit installs per event:
//
//   node $HOME/.config/cmux/scripts/hooks/dispatch.ts <Event>
//
// It reads the event's JSON from stdin once, picks the scripts routes.ts
// lists for that event whose matcher fits, and runs each as its own
// process with the same stdin, all at once, each with its own time limit.
// One that fails, hangs or crashes never stops the others. It always exits
// 0 and drops the scripts' stdout, so it can never block a tool or answer
// a permission prompt; their stderr is passed on, each line tagged.

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { scriptsFor } from "./routes.ts";

/** Each script's time limit; well inside Claude Code's 60 seconds for the hook as a whole. */
export const SCRIPT_TIMEOUT_MS = 30_000;

export interface Ran {
  script: string;
  /** The exit code, or null when it was killed or never started. */
  status: number | null;
  timedOut: boolean;
  stderr: string;
}

function runOne(dir: string, script: string, input: string, timeoutMs: number): Promise<Ran> {
  return new Promise((done) => {
    const child = spawn(process.execPath, [join(dir, script)], { stdio: ["pipe", "ignore", "pipe"] });
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (err) => {
      stderr += err.message;
    });
    child.on("close", (status) => {
      clearTimeout(timer);
      done({ script, status, timedOut, stderr });
    });
    // A script that exits without reading its input must not crash this one.
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}

/** Runs `scripts` from `dir` side by side, each with `input` on stdin, and settles once all have. */
export function runAll(dir: string, scripts: readonly string[], input: string, timeoutMs = SCRIPT_TIMEOUT_MS) {
  return Promise.all(scripts.map((s) => runOne(dir, s, input, timeoutMs)));
}

/** The event's JSON as an object, or null when it is not one. */
export function parsePayload(input: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(input);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>) // checked just above: a non-null, non-array object
      : null;
  } catch {
    return null;
  }
}

/** The stderr lines worth passing on for one script, tagged with its name. */
export function notes(r: Ran): string[] {
  const lines = r.stderr
    .split("\n")
    .map((l) => l.trimEnd())
    .filter((l) => l !== "");
  if (r.timedOut) lines.push(`stopped after ${SCRIPT_TIMEOUT_MS / 1000}s`);
  else if (r.status !== 0 && lines.length === 0) lines.push(`exited ${r.status ?? "on a signal"}`);
  return lines.map((l) => `dispatch ${r.script}: ${l}`);
}

if (import.meta.main) {
  try {
    const event = process.argv[2] ?? "";
    const input = readFileSync(0, "utf8");
    const scripts = scriptsFor(event, parsePayload(input));
    for (const r of await runAll(import.meta.dirname, scripts, input)) {
      for (const line of notes(r)) console.error(line);
    }
  } catch (err) {
    console.error(`dispatch: ${err instanceof Error ? err.message : String(err)}`);
  }
  process.exit(0);
}
