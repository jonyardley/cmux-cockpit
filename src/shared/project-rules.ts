// The rules a saved project keeps, in one copy: scripts/state-config.ts
// checks every value arriving from a URL against them, and the sidebar's
// editor (src/cockpit/edit.ts) uses the same ones to say why Done would not
// save. Pure, with no node imports, so a sidebar bundles it and a script
// imports it, as with project-sets.ts. The contract's types are imported as
// types only, so esbuild erases them.

import type { ProjectRemoved, SavedProject } from "../../scripts/state-config.ts";

/** The longest saved project key or folder. */
export const MAX_PROJECT_KEY = 512;
/** The longest project name. */
export const MAX_NAME = 64;

// A saved project is keyed by its first match, lowercase and at least two
// segments deep, so no URL can plant a "/" that swallows every folder. A
// sidebar-made one is an absolute folder ending in "/", matching that folder
// and no sibling that shares its prefix (projectOf adds the same "/" to the
// directory); a projects.json one is its fragment, often with no trailing "/".
export const isMatchKey = (v: string): boolean =>
  /^(\/[^/]+){2,}\/?$/.test(v) && v.length <= MAX_PROJECT_KEY && v === v.toLowerCase();

/** A six-digit hex colour, e.g. "#D97757". */
export const isHex = (v: unknown): v is string => typeof v === "string" && /^#[0-9a-f]{6}$/i.test(v);

/** An SF Symbol name: dotted lowercase words, e.g. "music.note". */
export const isSymbol = (v: unknown): v is string =>
  typeof v === "string" && /^[a-z0-9]+(\.[a-z0-9]+)*$/.test(v) && v.length <= 64;

/** Not a control character (0-31, or 127, DEL). */
export const isCleanChar = (c: string): boolean => {
  const code = c.charCodeAt(0);
  return code >= 32 && code !== 127;
};

/** Plain, single-line text with no leading, trailing or control characters, up to `max` long. */
export function isText(v: unknown, max: number): v is string {
  return typeof v === "string" && v.trim() === v && v.length > 0 && v.length <= max && [...v].every(isCleanChar);
}

export const isName = (v: unknown): v is string => isText(v, MAX_NAME);

/** Absolute, or under "~" as in projects.json (build.ts expands the "~"), up to MAX_PROJECT_KEY long. */
export const isRoot = (v: unknown): v is string =>
  typeof v === "string" && (v.startsWith("/") || v === "~" || v.startsWith("~/")) && v.length <= MAX_PROJECT_KEY;

export const isRemoved = (p: SavedProject): p is ProjectRemoved => "removed" in p;
