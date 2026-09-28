// Reading, backing up and writing ~/.claude/settings.json for the hooks
// extra, around the pure merge in hooks-merge.ts. The wanted list comes
// from claude-hooks.json, next to this file.

import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Paths, stamp } from "./env.ts";
import { type Entry, parseSettings, wantedEntries } from "./hooks-merge.ts";

export const HOOKS_SOURCE = join(import.meta.dirname, "claude-hooks.json");

/** The hooks setup adds, from the one committed list. */
export const wanted = (): Entry[] => wantedEntries(JSON.parse(readFileSync(HOOKS_SOURCE, "utf8")));

// Hooks setup once added whose scripts have since gone. Left in place they
// fail at the end of every turn, so setup and uninstall take them out and
// doctor flags them.
const RETIRED = [{ event: "Stop", command: "node $HOME/.config/cmux/scripts/hooks/report-mention.ts" }];

/** The retired hooks, as entries removeEntries can take out. */
export const retired = (): Entry[] =>
  RETIRED.map(({ event, command }) => ({ event, matcher: null, command, hook: { type: "command", command } }));

export type Loaded =
  | { ok: true; settings: Record<string, unknown>; existed: boolean; text: string }
  | { ok: false; error: string };

/** The settings file, parsed; a missing one reads as empty. */
export function loadSettings(paths: Paths): Loaded {
  if (!existsSync(paths.claudeSettings)) return { ok: true, settings: {}, existed: false, text: "" };
  const text = readFileSync(paths.claudeSettings, "utf8");
  const parsed = parseSettings(text);
  return parsed.ok ? { ok: true, settings: parsed.settings, existed: true, text } : parsed;
}

/** True when the file still holds what `loaded` read, so a write cannot lose one Claude Code made meanwhile. */
export function unchanged(paths: Paths, loaded: { existed: boolean; text: string }): boolean {
  if (!existsSync(paths.claudeSettings)) return !loaded.existed;
  return loaded.existed && readFileSync(paths.claudeSettings, "utf8") === loaded.text;
}

/** Copies the settings file aside before a write; an earlier backup is kept and this one takes a time stamp. */
export function backupSettings(paths: Paths, now: Date): string {
  const to = existsSync(paths.claudeBackup) ? `${paths.claudeBackup}-${stamp(now)}` : paths.claudeBackup;
  copyFileSync(paths.claudeSettings, to);
  return to;
}

/**
 * Writes the file whole, through a temp file and a rename, so a crash never
 * leaves half of it. A settings.json that is a link (a dotfiles repo, say)
 * is written through: the file it points at is replaced, the link kept.
 */
export function writeSettings(paths: Paths, settings: Record<string, unknown>): void {
  mkdirSync(paths.claudeDir, { recursive: true });
  const target = existsSync(paths.claudeSettings) ? realpathSync(paths.claudeSettings) : paths.claudeSettings;
  const tmp = `${target}.cmux-cockpit.tmp`;
  writeFileSync(tmp, `${JSON.stringify(settings, null, 2)}\n`);
  renameSync(tmp, target);
}
