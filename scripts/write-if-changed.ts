// The build's one write (scripts/build.ts): cmux hot-reloads a sidebar
// whenever its file is written, and the reload redraws the whole panel, a
// visible flicker, so a bundle whose bytes have not changed is left alone.

import { closeSync, mkdirSync, openSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Touched on every build, so the doctor can tell a fresh build from a stale
 * one now that an unchanged bundle keeps its old modification time.
 */
export const BUILT_MARK = "config/last-build";

// The file's bytes, or null when there is none to compare with.
function bytesOf(path: string): Buffer | null {
  try {
    return readFileSync(path);
  } catch {
    return null;
  }
}

/** Writes `contents` to `path` unless the file already holds exactly them; true when it wrote. */
export function writeIfChanged(path: string, contents: Uint8Array): boolean {
  if (bytesOf(path)?.equals(contents)) return false;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
  return true;
}

/** Sets `path`'s modification time to now, making it empty first if it is not there. */
export function touchBuilt(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  closeSync(openSync(path, "a"));
  const now = new Date();
  utimesSync(path, now, now);
}
