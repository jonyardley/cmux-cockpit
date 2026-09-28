// Flags for npm run setup and npm run uninstall. They go after "--"
// (`npm run setup -- --yes`): without it npm keeps them for itself. npm's
// npm_config_yes is not read, since a yes=true line in .npmrc sets it too
// and would answer every question unasked.

export const EXTRAS = ["helper", "automations", "hooks"] as const;
export type Extra = (typeof EXTRAS)[number];

export interface Flags {
  /** Yes to every question. */
  yes: boolean;
  /** No extras at all. */
  noExtras: boolean;
  /** Extras named on the command line; the rest are left alone without asking. */
  picked: Extra[];
}

const isExtra = (s: string): s is Extra => (EXTRAS as readonly string[]).includes(s);

/** The flags in `argv`, or an error naming the one it does not know. */
export function parseFlags(argv: readonly string[]): Flags | string {
  const flags: Flags = { yes: false, noExtras: false, picked: [] };
  for (const arg of argv) {
    const name = arg.replace(/^--/, "");
    if (arg === "--yes" || arg === "-y") flags.yes = true;
    else if (arg === "--no-extras") flags.noExtras = true;
    else if (arg.startsWith("--") && isExtra(name)) {
      if (!flags.picked.includes(name)) flags.picked.push(name);
    } else
      return `unknown argument ${JSON.stringify(arg)}; it takes --yes, --no-extras, --helper, --automations, --hooks`;
  }
  return flags;
}

export type Choice = "yes" | "no" | "ask";

/** Whether to add one extra: from the flags when they settle it, else asked on a terminal, else skipped. */
export function choose(extra: Extra, flags: Flags, interactive: boolean): Choice {
  if (flags.noExtras) return "no";
  if (flags.yes || flags.picked.includes(extra)) return "yes";
  if (flags.picked.length > 0) return "no";
  return interactive ? "ask" : "no";
}

/** Uninstall: whether to offer to remove one extra. The flags narrow it as they do for setup. */
export const offered = (extra: Extra, flags: Flags): boolean =>
  !flags.noExtras && (flags.picked.length === 0 || flags.picked.includes(extra));
