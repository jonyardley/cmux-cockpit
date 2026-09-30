// The one Claude Code hook the cockpit installs per event:
//
//   node $HOME/.config/cmux/scripts/hooks/dispatch.ts <Event>
//
// It reads the event's JSON from stdin once, picks the scripts routes.ts
// lists for that event whose matcher fits, and runs each as its own
// process with the same stdin, all at once, each with its own time limit.
// One that fails, hangs or crashes never stops the others. It always exits
// 0 and drops the scripts' stdout, so it can never block a tool or answer
// a permission prompt; their stderr is passed on, each line tagged. The one
// exception is a Stop script routes.ts marks sendsBack: its block decision
// is passed on, so the turn goes back to the chat (report-move.ts). Only
// those scripts' stdout is read at all. Each
// script runs in its own process group, so a time limit, or Claude Code
// stopping this one, ends whatever the script started too.

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { field } from "./gh-command.ts";
import { scriptsFor, sendersFor } from "./routes.ts";

/** Each script's time limit; well inside Claude Code's 60 seconds for the hook as a whole. */
export const SCRIPT_TIMEOUT_MS = 30_000;

export interface Ran {
  script: string;
  /** The exit code, or null when it was killed or never started. */
  status: number | null;
  timedOut: boolean;
  /** The limit it ran under, in milliseconds. */
  limitMs: number;
  stderr: string;
  stdout: string;
}

// The process groups still running, so a stop can end them all.
const running = new Set<number>();

// Ends one script's whole process group; one already gone is fine.
function killGroup(pid: number): void {
  try {
    process.kill(-pid, "SIGKILL");
  } catch {}
}

/** Ends every script still running, and whatever each started. */
export function stopAll(): void {
  for (const pid of running) killGroup(pid);
  running.clear();
}

function runOne(dir: string, script: string, input: string, limitMs: number, readOut: boolean): Promise<Ran> {
  return new Promise((done) => {
    const child = spawn(process.execPath, [join(dir, script)], {
      stdio: ["pipe", readOut ? "pipe" : "ignore", "pipe"],
      detached: true,
    });
    const pid = child.pid;
    if (pid !== undefined) running.add(pid);
    let stderr = "";
    let stdout = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      if (pid !== undefined) killGroup(pid);
    }, limitMs);
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.on("error", (err) => {
      stderr += err.message;
    });
    child.on("close", (status) => {
      clearTimeout(timer);
      if (pid !== undefined) running.delete(pid);
      done({ script, status, timedOut, limitMs, stderr, stdout });
    });
    // A script that exits without reading its input must not crash this one.
    child.stdin?.on("error", () => {});
    child.stdin?.end(input);
  });
}

/**
 * Runs `scripts` from `dir` side by side, each with `input` on stdin, and
 * settles once all have. Only the `senders`' stdout is kept; the rest is
 * dropped at the source.
 */
export function runAll(
  dir: string,
  scripts: readonly string[],
  input: string,
  timeoutMs = SCRIPT_TIMEOUT_MS,
  senders: readonly string[] = [],
) {
  return Promise.all(scripts.map((s) => runOne(dir, s, input, timeoutMs, senders.includes(s))));
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

/**
 * The block decision to hand Claude Code, as a JSON line, or null. Only from
 * a script in `senders` that finished cleanly and printed a decision of
 * "block" with a reason; the first such one wins.
 */
export function sendBack(ran: readonly Ran[], senders: readonly string[]): string | null {
  for (const r of ran) {
    if (!senders.includes(r.script) || r.status !== 0 || r.timedOut) continue;
    const out = parsePayload(r.stdout.trim());
    const reason = field(out, "reason");
    if (field(out, "decision") === "block" && typeof reason === "string" && reason)
      return JSON.stringify({ decision: "block", reason });
  }
  return null;
}

/** The stderr lines worth passing on for one script, tagged with its name. */
export function notes(r: Ran): string[] {
  const lines = r.stderr
    .split("\n")
    .map((l) => l.trimEnd())
    .filter((l) => l !== "");
  if (r.timedOut) lines.push(`stopped after ${r.limitMs / 1000}s`);
  else if (r.status !== 0 && lines.length === 0) lines.push(`exited ${r.status ?? "on a signal"}`);
  return lines.map((l) => `dispatch ${r.script}: ${l}`);
}

if (import.meta.main) {
  // Claude Code stopping this hook (a timeout, or Esc) stops the scripts too.
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
    process.on(signal, () => {
      stopAll();
      process.exit(0);
    });
  }
  try {
    const event = process.argv[2] ?? "";
    const input = readFileSync(0, "utf8");
    const payload = parsePayload(input);
    const senders = sendersFor(event, payload);
    const ran = await runAll(import.meta.dirname, scriptsFor(event, payload), input, SCRIPT_TIMEOUT_MS, senders);
    for (const r of ran) {
      for (const line of notes(r)) console.error(line);
    }
    const decision = sendBack(ran, senders);
    if (decision) console.log(decision);
  } catch (err) {
    console.error(`dispatch: ${err instanceof Error ? err.message : String(err)}`);
  }
  process.exit(0);
}
