// The pure parts of the URL handler (docs/state-loop.md): parsing a
// cmux-cockpit:// URL into a {key, value} pair, and the read-apply-write
// step against config/state.json. Kept apart from state-set.ts so both can
// be tested without a subprocess, and the file step against a temp dir.
//
// Every URL is untrusted input: parsing never throws, and an unrecognised
// shape is refused rather than guessed at.

import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { applySet, validateState } from "./state-config.ts";

export type ParsedSet = { ok: true; key: string; value: string | null } | { ok: false; error: string };

// The only query params the URL is allowed to carry.
const ALLOWED_PARAMS = new Set(["key", "value"]);

/** Parses `cmux-cockpit://set?key=<map>.<wsId>&value=<json>` (value absent = delete). */
export function parseSetUrl(raw: string): ParsedSet {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, error: `not a URL: ${raw}` };
  }
  if (url.protocol !== "cmux-cockpit:") return { ok: false, error: `wrong protocol ${url.protocol}` };
  if (url.host !== "set") return { ok: false, error: `wrong host ${url.host}` };
  for (const param of url.searchParams.keys()) {
    if (!ALLOWED_PARAMS.has(param)) return { ok: false, error: `unknown param ${param}` };
  }
  const key = url.searchParams.get("key");
  if (!key) return { ok: false, error: "missing key" };
  return { ok: true, key, value: url.searchParams.get("value") };
}

export type ApplyResult = { ok: true } | { ok: false; error: string };

/**
 * Reads the state file, applies one set, and writes it back atomically
 * (a `.tmp` write then rename). A missing or unparseable file reads as
 * empty state, per the contract; a refused set leaves the file untouched.
 */
export function readApplyWrite(path: string, key: string, value: string | null): ApplyResult {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    raw = undefined;
  }
  const result = applySet(validateState(raw), key, value);
  if (!result.ok) return result;

  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(result.state, null, 2)}\n`);
  renameSync(tmp, path);
  return { ok: true };
}
