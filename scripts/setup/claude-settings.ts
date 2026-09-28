// Reading, backing up and writing Claude Code's settings.json (in
// CLAUDE_CONFIG_DIR when set, else ~/.claude) for the hooks extra, around
// the pure merge in hooks-merge.ts. The wanted list comes from
// claude-hooks.json, next to this file.

import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Paths, stamp } from "./env.ts";
import { type Entry, missingEntries, parseSettings, wantedEntries } from "./hooks-merge.ts";

export const HOOKS_SOURCE = join(import.meta.dirname, "claude-hooks.json");

/** The hooks setup adds, from the one committed list. */
export const wanted = (): Entry[] => wantedEntries(JSON.parse(readFileSync(HOOKS_SOURCE, "utf8")));

export type Loaded =
  | { ok: true; settings: Record<string, unknown>; existed: boolean; text: string }
  | { ok: false; error: string };

function loadFile(file: string): Loaded {
  if (!existsSync(file)) return { ok: true, settings: {}, existed: false, text: "" };
  const text = readFileSync(file, "utf8");
  const parsed = parseSettings(text);
  return parsed.ok ? { ok: true, settings: parsed.settings, existed: true, text } : parsed;
}

/** The settings file, parsed; a missing one reads as empty. */
export const loadSettings = (paths: Paths): Loaded => loadFile(paths.claudeSettings);

/**
 * One line each for what setup and the doctor should say about where the
 * hooks go: a CLAUDE_CONFIG_DIR that was ignored, and cockpit hooks left in
 * ~/.claude/settings.json while CLAUDE_CONFIG_DIR points elsewhere. Those
 * are never removed here: ~/.claude may be a Claude profile kept on purpose.
 */
export function claudeDirNotes(paths: Paths, home: string): string[] {
  const notes: string[] = [];
  if (paths.claudeConfigIgnored !== undefined) {
    notes.push(
      `CLAUDE_CONFIG_DIR is "${paths.claudeConfigIgnored}", not an absolute path, so it is ignored and ~/.claude is used`,
    );
  }
  if (paths.otherClaudeSettings !== undefined) {
    const other = loadFile(paths.otherClaudeSettings);
    const held = other.ok ? wanted().length - missingEntries(other.settings, wanted(), home).length : 0;
    if (held > 0) {
      notes.push(
        `~/.claude/settings.json also holds ${held} cockpit hooks; they are left alone, so take them out by hand if nothing starts Claude Code without CLAUDE_CONFIG_DIR`,
      );
    }
  }
  return notes;
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
