// The build's one write (scripts/build.ts): cmux hot-reloads a sidebar
// whenever its file is written, and the reload redraws the whole panel, a
// visible flicker, so a bundle whose bytes have not changed is left alone.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** Writes `contents` to `path` unless the file already holds exactly them; true when it wrote. */
export function writeIfChanged(path: string, contents: Uint8Array): boolean {
  if (existsSync(path) && readFileSync(path).equals(contents)) return false;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
  return true;
}
