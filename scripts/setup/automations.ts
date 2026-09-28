// Linking ~/.cmuxterm/automations.json to the repo's rules, as the
// quickstart does by hand, and unlinking it again. What to do is decided by
// a pure function over what is there now; the fs steps only carry it out.

import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
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
  | { kind: "other-link"; target: string }
  | { kind: "file"; ruleIds: string[] | null };

export type Plan =
  | { do: "link"; replacing: string | null }
  | { do: "backup-and-link" }
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
 * What setup does: link when nothing is there, leave our link alone, swap
 * another link, and back up a real file first, unless it holds rules the
 * repo's file lacks. Those would stop running, so it skips and says which.
 */
export function planLink(state: LinkState, repoIds: readonly string[]): Plan {
  switch (state.kind) {
    case "missing":
      return { do: "link", replacing: null };
    case "ours":
      return { do: "nothing", why: "already linked to this repo's automations.json" };
    case "other-link":
      return { do: "link", replacing: state.target };
    case "file": {
      if (state.ruleIds === null) {
        return { do: "skip", why: "the existing file is not an automations file setup can read, so it is left alone" };
      }
      const extra = state.ruleIds.filter((id) => !repoIds.includes(id));
      if (extra.length === 0) return { do: "backup-and-link" };
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

/** Reads what is at the link path now. */
export function linkState(paths: Paths): LinkState {
  const st = lstatSync(paths.automationsLink, { throwIfNoEntry: false });
  if (!st) return { kind: "missing" };
  if (st.isSymbolicLink()) {
    const target = targetOf(paths.automationsLink);
    return target === paths.repoAutomations ? { kind: "ours" } : { kind: "other-link", target };
  }
  return { kind: "file", ruleIds: ruleIds(readFileSync(paths.automationsLink, "utf8")) };
}

/** The repo's own rule ids. */
export const repoRuleIds = (paths: Paths): string[] => ruleIds(readFileSync(paths.repoAutomations, "utf8")) ?? [];

/** Carries out a link or backup-and-link plan; returns what it did, one line each. */
export function applyLink(plan: Plan, paths: Paths, now: Date): string[] {
  if (plan.do === "nothing" || plan.do === "skip") return [];
  const did: string[] = [];
  mkdirSync(paths.cmuxterm, { recursive: true });
  if (plan.do === "backup-and-link") {
    // An earlier backup is kept; this one takes a time stamp instead.
    const backup = existsSync(paths.automationsBackup)
      ? `${paths.automationsBackup}-${stamp(now)}`
      : paths.automationsBackup;
    renameSync(paths.automationsLink, backup);
    did.push(`backed up the old file to ${backup}`);
  } else if (plan.replacing !== null) {
    unlinkSync(paths.automationsLink);
    did.push(`replaced a link to ${plan.replacing}`);
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
