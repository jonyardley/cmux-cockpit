// Reading, backing up and writing each Claude Code settings.json setup looks
// after, around the pure merge in hooks-merge.ts. What goes in is one entry
// point per event in scripts/hooks/routes.ts; which scripts each runs stays
// in that file, read at run time, so settings only change when an event is
// added or dropped.

import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { ROUTES } from "../hooks/routes.ts";
import { type ClaudeFolder, type Paths, stamp } from "./env.ts";
import {
  canonical,
  type Drop,
  type Entry,
  everything,
  missingEntries,
  parseSettings,
  removeHooks,
} from "./hooks-merge.ts";

const HOOKS_DIR = "$HOME/.config/cmux/scripts/hooks";

/** The command Claude Code runs for one event. */
export const entryCommand = (event: string): string => `node ${HOOKS_DIR}/dispatch.ts ${event}`;

/** The entry points setup adds: one per event routes.ts lists, with no matcher, since dispatch.ts does the matching. */
export const wanted = (): Entry[] =>
  Object.keys(ROUTES).map((event) => {
    const command = entryCommand(event);
    return { event, matcher: null, command, hook: { type: "command", command } };
  });

// The scripts setup once added to settings one by one, before the entry
// points. Left in beside them each would run twice, so setup and uninstall
// take them out under any matcher, and doctor flags them. report-mention.ts
// has since gone altogether. Report scripts added since are listed too, so
// one also added by hand is never run twice.
const LEGACY_SCRIPTS = [
  "report-subagent.ts",
  "report-notification.ts",
  "report-pr.ts",
  "report-published.ts",
  "report-move.ts",
  "report-rename.ts",
  "report-shell.ts",
  "report-mention.ts",
];

/** The per-script commands the entry points replace. */
export const legacy = (): string[] => LEGACY_SCRIPTS.map((s) => `node ${HOOKS_DIR}/${s}`);

// Every entry point command, whatever its event, as canonical() spells it.
const isEntryPoint = (command: string, home: string): boolean =>
  command.startsWith(`${canonical(`node ${HOOKS_DIR}/dispatch.ts`, home)} `);

/**
 * The cockpit hooks setup takes out and doctor flags: the old per-script
 * ones, and an entry point that no longer fits, being under a matcher that
 * narrows it (it would skip events and sit beside the proper one) or for
 * an event it has no routes for, or for another event than its own.
 */
export function stale(home: string): Drop {
  const old = new Set(legacy().map((c) => canonical(c, home)));
  return (event, matcher, command) => {
    if (old.has(command)) return true;
    if (!isEntryPoint(command, home)) return false;
    const proper = event in ROUTES && command === canonical(entryCommand(event), home);
    return !(proper && everything(matcher));
  };
}

/** Every cockpit hook, old or current, for uninstall. */
export function cockpit(home: string): Drop {
  const old = stale(home);
  return (event, matcher, command) => isEntryPoint(command, home) || old(event, matcher, command);
}

export type Loaded =
  | { ok: true; settings: Record<string, unknown>; existed: boolean; text: string }
  | { ok: false; error: string };

/** A folder's settings file, parsed; a missing one reads as empty. */
export function loadSettings(folder: ClaudeFolder): Loaded {
  if (!existsSync(folder.settings)) return { ok: true, settings: {}, existed: false, text: "" };
  const text = readFileSync(folder.settings, "utf8");
  const parsed = parseSettings(text);
  return parsed.ok ? { ok: true, settings: parsed.settings, existed: true, text } : parsed;
}

/**
 * The Claude Code folders the hooks go in: CLAUDE_CONFIG_DIR's (or
 * ~/.claude when it is unset or ignored) always, and ~/.claude as well
 * when it is another folder that exists, since Claude Code started
 * without the variable reads it.
 */
export function claudeFolders(paths: Paths): ClaudeFolder[] {
  const { claudeDefault, claudeConfigured } = paths;
  if (resolve(claudeDefault.dir) === resolve(claudeConfigured.dir)) return [claudeConfigured];
  return existsSync(claudeDefault.dir) ? [claudeDefault, claudeConfigured] : [claudeConfigured];
}

/** What a folder's settings hold of the cockpit's: entry points missing, and stale hooks left. */
export function hooksState(settings: Record<string, unknown>, home: string) {
  return {
    missing: missingEntries(settings, wanted(), home),
    stale: removeHooks(settings, stale(home), home).removed,
  };
}

/** One line for setup and the doctor when CLAUDE_CONFIG_DIR was set but ignored. */
export function claudeDirNotes(paths: Paths): string[] {
  if (paths.claudeConfigIgnored === undefined) return [];
  return [
    `CLAUDE_CONFIG_DIR is "${paths.claudeConfigIgnored}", not an absolute path, so it is ignored and ~/.claude is used`,
  ];
}

/** True when the file still holds what `loaded` read, so a write cannot lose one Claude Code made meanwhile. */
export function unchanged(folder: ClaudeFolder, loaded: { existed: boolean; text: string }): boolean {
  if (!existsSync(folder.settings)) return !loaded.existed;
  return loaded.existed && readFileSync(folder.settings, "utf8") === loaded.text;
}

/** Copies the settings file aside before a write; an earlier backup is kept and this one takes a time stamp. */
export function backupSettings(folder: ClaudeFolder, now: Date): string {
  const to = existsSync(folder.backup) ? `${folder.backup}-${stamp(now)}` : folder.backup;
  copyFileSync(folder.settings, to);
  return to;
}

/**
 * Writes the file whole, through a temp file and a rename, so a crash never
 * leaves half of it. A settings.json that is a link (a dotfiles repo, say)
 * is written through: the file it points at is replaced, the link kept.
 */
export function writeSettings(folder: ClaudeFolder, settings: Record<string, unknown>): void {
  mkdirSync(folder.dir, { recursive: true });
  const target = existsSync(folder.settings) ? realpathSync(folder.settings) : folder.settings;
  const tmp = `${target}.cmux-cockpit.tmp`;
  writeFileSync(tmp, `${JSON.stringify(settings, null, 2)}\n`);
  renameSync(tmp, target);
}
