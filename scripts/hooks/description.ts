// A workspace's cmux description, which two hooks write: report-move.ts
// puts the chat's move there and status-context.ts its context tail. Each
// reads, changes its own part and writes the whole back, so each holds the
// workspace's lock for that, or one would put back what the other just
// replaced (a move lost, or old figures restored).

import { mkdirSync, rmdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cmux } from "./cmux-cli.ts";
import { field } from "./gh-command.ts";

/**
 * What cmux says the workspace's description is: the text, "" for none, or
 * why it could not say. "unlisted" is a workspace cmux's list does not hold,
 * which asking again will not change; "silent" is cmux failing to answer at
 * all, which a busy cmux may do once.
 */
export type DescriptionRead = { ok: true; text: string } | { ok: false; why: "unlisted" | "silent" };

const SILENT: DescriptionRead = { ok: false, why: "silent" };

export function readDescription(wsId: string): DescriptionRead {
  const res = cmux(["--json", "workspace", "list"]);
  if (!res.ok) return SILENT;
  try {
    const list = field(JSON.parse(res.out), "workspaces");
    const ws = Array.isArray(list) ? list.find((w) => field(w, "id") === wsId) : undefined;
    if (ws === undefined) return { ok: false, why: "unlisted" };
    const d = field(ws, "description");
    return { ok: true, text: typeof d === "string" ? d : "" };
  } catch {
    return SILENT;
  }
}

/** Sets the description, or clears it for null; false when cmux refused, which `who` notes on stderr. */
export function writeDescription(who: string, wsId: string, description: string | null): boolean {
  const args = ["workspace-action", "--workspace", wsId];
  const res = cmux(
    description === null
      ? [...args, "--action", "clear-description"]
      : [...args, "--action", "set-description", "--description", description],
  );
  if (!res.ok) console.error(`${who}: cmux refused the description: ${res.err}`);
  return res.ok;
}

/** A lock older than this is a crashed holder's, and is taken over. */
const STALE_MS = 15_000;
const lockPath = (wsId: string): string => join(tmpdir(), `cmux-cockpit-description-${wsId}.lock`);

// Takes the lock: making a folder is atomic, so only one process gets it.
function take(path: string): boolean {
  try {
    mkdirSync(path);
    return true;
  } catch {
    try {
      if (Date.now() - statSync(path).mtimeMs > STALE_MS) rmdirSync(path);
    } catch {}
    return false;
  }
}

const pause = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

/**
 * Runs `body` holding the workspace's description lock, waiting up to
 * `waitMs` for it; `busy` instead when it stays taken. A workspace id names
 * a file here, so one with a path in it runs nothing and gets `busy` too.
 */
export function withDescriptionLock<T>(wsId: string, waitMs: number, body: () => T, busy: () => T): T {
  if (/[/\\]/.test(wsId)) return busy();
  const path = lockPath(wsId);
  const until = Date.now() + waitMs;
  while (!take(path)) {
    if (Date.now() >= until) return busy();
    pause(50);
  }
  try {
    return body();
  } finally {
    try {
      rmdirSync(path);
    } catch {}
  }
}
