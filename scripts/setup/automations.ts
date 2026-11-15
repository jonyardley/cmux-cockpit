// Linking ~/.cmuxterm/automations.json to the repo's rules, as the
// quickstart does by hand, and unlinking it again. What to do is decided by
// a pure function over what is there now; the fs steps only carry it out.

import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { type Paths, stamp } from "./env.ts";

/** What sits at ~/.cmuxterm/automations.json now. */
export type LinkState =
  | { kind: "missing" }
  | { kind: "ours" }
  /** A plain file, or a link somewhere else (`target`); either is backed up, never deleted. */
  | { kind: "file"; ruleIds: string[] | null; target: string | null };

export type Plan =
  | { do: "link" }
  | { do: "backup-and-link"; target: string | null }
  | { do: "nothing"; why: string }
  | { do: "skip"; why: string };

/** Rule ids in an automations file's text: null when it is not the { rules: [...] } shape. Unnamed rules show by index. */
export function ruleIds(text: string): string[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || !("rules" in parsed) || !Array.isArray(parsed.rules)) {
    return null;
  }
  return parsed.rules.map((r: unknown, i) =>
    typeof r === "object" && r !== null && "id" in r && typeof r.id === "string" ? r.id : `(unnamed rule ${i + 1})`,
  );
}

/**
 * What setup does: link when nothing is there, and leave our link alone.
 * Anything else, a plain file or a link to another file, is backed up
 * first, unless it holds rules the repo's file lacks: those would stop
 * running, so it skips and says which. So a backup only ever holds rules
 * the repo also has, which is why a second one can take a time stamp and
 * uninstall still puts back the first.
 */
export function planLink(state: LinkState, repoIds: readonly string[]): Plan {
  switch (state.kind) {
    case "missing":
      return { do: "link" };
    case "ours":
      return { do: "nothing", why: "already linked to this repo's automations.json" };
    case "file": {
      if (state.ruleIds === null) {
        return { do: "skip", why: "the existing file is not an automations file setup can read, so it is left alone" };
      }
      const extra = state.ruleIds.filter((id) => !repoIds.includes(id));
      if (extra.length === 0) return { do: "backup-and-link", target: state.target };
      return {
        do: "skip",
        why:
          `the existing file has rules the repo's does not: ${extra.join(", ")}. ` +
          "Copy them into ~/.config/cmux/automations.json, then run setup again",
      };
    }
  }
}

// Where a link points, made absolute against the link's folder.
const targetOf = (link: string): string => resolve(dirname(link), readlinkSync(link));

// The same file, symbolic links in the path resolved, so a ~/.config that is itself a link still matches.
function sameFile(a: string, b: string): boolean {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return a === b;
  }
}

// A file's rule ids, or [] for a link to nothing, which has no rules to lose.
function idsAt(path: string): string[] | null {
  try {
    return ruleIds(readFileSync(path, "utf8"));
  } catch {
    return [];
  }
}

/** Reads what is at the link path now. */
export function linkState(paths: Paths): LinkState {
  const st = lstatSync(paths.automationsLink, { throwIfNoEntry: false });
  if (!st) return { kind: "missing" };
  const target = st.isSymbolicLink() ? targetOf(paths.automationsLink) : null;
  if (target !== null && sameFile(target, paths.repoAutomations)) return { kind: "ours" };
  return { kind: "file", ruleIds: idsAt(paths.automationsLink), target };
}

/** The repo's own rule ids. */
export const repoRuleIds = (paths: Paths): string[] => ruleIds(readFileSync(paths.repoAutomations, "utf8")) ?? [];

/** Carries out a link or backup-and-link plan; returns what it did, one line each. */
export function applyLink(plan: Plan, paths: Paths, now: Date): string[] {
  if (plan.do === "nothing" || plan.do === "skip") return [];
  const did: string[] = [];
  mkdirSync(paths.cmuxterm, { recursive: true });
  if (plan.do === "backup-and-link") {
    // An earlier backup is kept; this one takes a time stamp instead. A
    // link is moved as a link, so the file it points at is untouched.
    const backup = existsSync(paths.automationsBackup)
      ? `${paths.automationsBackup}-${stamp(now)}`
      : paths.automationsBackup;
    renameSync(paths.automationsLink, backup);
    did.push(`backed up the old ${plan.target ? `link to ${plan.target}` : "file"} to ${backup}`);
  }
  symlinkSync(paths.repoAutomations, paths.automationsLink);
  did.push(`linked ${paths.automationsLink} to ${paths.repoAutomations}`);
  return did;
}

/** Uninstall: removes our link only, then puts automations.json.backup back if there is one. */
export function removeLink(paths: Paths): string[] {
  if (linkState(paths).kind !== "ours") return [];
  unlinkSync(paths.automationsLink);
  const did = [`removed the link ${paths.automationsLink}`];
  if (existsSync(paths.automationsBackup)) {
    renameSync(paths.automationsBackup, paths.automationsLink);
    did.push(`restored ${paths.automationsBackup}`);
  }
  return did;
}
