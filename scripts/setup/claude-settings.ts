// Reading, backing up and writing ~/.claude/settings.json for the hooks
// extra, around the pure merge in hooks-merge.ts. The wanted list comes
// from claude-hooks.json, next to this file.

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Paths, stamp } from "./env.ts";
import { type Entry, parseSettings, wantedEntries } from "./hooks-merge.ts";

export const HOOKS_SOURCE = join(import.meta.dirname, "claude-hooks.json");

/** The hooks setup adds, from the one committed list. */
export const wanted = (): Entry[] => wantedEntries(JSON.parse(readFileSync(HOOKS_SOURCE, "utf8")));

export type Loaded = { ok: true; settings: Record<string, unknown>; existed: boolean } | { ok: false; error: string };

/** The settings file, parsed; a missing one reads as empty. */
export function loadSettings(paths: Paths): Loaded {
  if (!existsSync(paths.claudeSettings)) return { ok: true, settings: {}, existed: false };
  const parsed = parseSettings(readFileSync(paths.claudeSettings, "utf8"));
  return parsed.ok ? { ok: true, settings: parsed.settings, existed: true } : parsed;
}

/** Copies the settings file aside before a write; an earlier backup is kept and this one takes a time stamp. */
export function backupSettings(paths: Paths, now: Date): string {
  const to = existsSync(paths.claudeBackup) ? `${paths.claudeBackup}-${stamp(now)}` : paths.claudeBackup;
  copyFileSync(paths.claudeSettings, to);
  return to;
}

export function writeSettings(paths: Paths, settings: Record<string, unknown>): void {
  mkdirSync(paths.claudeDir, { recursive: true });
  writeFileSync(paths.claudeSettings, `${JSON.stringify(settings, null, 2)}\n`);
}
