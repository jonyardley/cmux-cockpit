// Flags for npm run setup and npm run uninstall. npm keeps flags it knows
// for itself unless they follow "--", so `npm run setup --yes` reaches the
// script only as npm_config_yes; the env fallbacks catch that spelling too.

export const EXTRAS = ["helper", "automations", "hooks"] as const;
export type Extra = (typeof EXTRAS)[number];

export interface Flags {
  /** Yes to every question. */
  yes: boolean;
  /** No extras at all. */
  noExtras: boolean;
  /** Extras named on the command line; the rest are skipped without asking. */
  picked: Extra[];
}

const isExtra = (s: string): s is Extra => (EXTRAS as readonly string[]).includes(s);

/** The flags in `argv` (and npm's env copies of them), or an error naming the one it does not know. */
export function parseFlags(argv: readonly string[], env: Record<string, string | undefined> = {}): Flags | string {
  const flags: Flags = {
    yes: env.npm_config_yes === "true",
    noExtras: env.npm_config_extras === "false",
    picked: EXTRAS.filter((e) => env[`npm_config_${e}`] === "true"),
  };
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
