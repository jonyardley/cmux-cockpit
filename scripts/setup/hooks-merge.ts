// Adding the cockpit's Claude Code hooks to a settings.json, and taking them
// out again, as pure functions over parsed JSON. Adding never removes,
// reorders or rewrites anything: a missing hook goes in as a new group at
// the end of its event's list. Removing takes out only the commands it is
// given, under whatever matcher they sit, and a group or event only when
// that leaves it empty.

type Obj = Record<string, unknown>;

/** One hook the cockpit wants: its event, its matcher (null when it has none) and the hook object itself. */
export interface Entry {
  event: string;
  matcher: string | null;
  command: string;
  hook: Obj;
}

export type Parsed = { ok: true; settings: Obj } | { ok: false; error: string };

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

// A group is { matcher?: string, hooks: object[] } plus anything else Claude Code adds.
function groupError(group: unknown): string | null {
  if (!isObj(group)) return "is not an object";
  if (group.matcher !== undefined && typeof group.matcher !== "string") return "has a matcher that is not a string";
  if (!Array.isArray(group.hooks) || !group.hooks.every(isObj)) return "has no hooks list of objects";
  return null;
}

/** Null when `hooks` is absent or the shape Claude Code reads, else what is wrong with it. */
export function hooksShapeError(hooks: unknown): string | null {
  if (hooks === undefined) return null;
  if (!isObj(hooks)) return '"hooks" is not an object';
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) return `"hooks.${event}" is not a list`;
    for (const [i, group] of groups.entries()) {
      const why = groupError(group);
      if (why) return `"hooks.${event}[${i}]" ${why}`;
    }
  }
  return null;
}

/** The settings file's text as an object, refusing anything that is not JSON or has hooks of a shape we do not know. */
export function parseSettings(text: string): Parsed {
  let settings: unknown;
  try {
    settings = JSON.parse(text);
  } catch (err) {
    return { ok: false, error: `not valid JSON (${err instanceof Error ? err.message : String(err)})` };
  }
  if (!isObj(settings)) return { ok: false, error: "not a JSON object" };
  const why = hooksShapeError(settings.hooks);
  return why ? { ok: false, error: why } : { ok: true, settings };
}

// hooksShapeError has checked every level this reads, so the casts hold.
function groupsOf(settings: Obj): Record<string, Obj[]> {
  return isObj(settings.hooks) ? (settings.hooks as Record<string, Obj[]>) : {};
}

// A group's hooks: hooksShapeError checked each is an object.
const hooksOf = (group: Obj): Obj[] => (Array.isArray(group.hooks) ? (group.hooks as Obj[]) : []);

// Missing and "" both match everything in Claude Code, so they are the same here.
const matcherOf = (group: Obj): string => (typeof group.matcher === "string" ? group.matcher : "");

/** A command with $HOME, ${HOME} and a leading ~/ spelled as `home`, so each spelling reads as the same hook. */
export function canonical(command: string, home: string): string {
  return command
    .replace(/\$\{HOME\}|\$HOME\b/g, () => home)
    .replace(/(^|\s)~\//g, (_, lead: string) => `${lead}${home}/`)
    .trim();
}

function has(settings: Obj, e: Entry, home: string): boolean {
  const want = canonical(e.command, home);
  const groups = groupsOf(settings)[e.event] ?? [];
  return groups.some(
    (g) =>
      matcherOf(g) === (e.matcher ?? "") &&
      hooksOf(g).some((h) => typeof h.command === "string" && canonical(h.command, home) === want),
  );
}

/** The wanted entries not already in `settings` for their event and matcher. */
export function missingEntries(settings: Obj, wanted: readonly Entry[], home: string): Entry[] {
  return wanted.filter((e) => !has(settings, e, home));
}

/**
 * A copy of `settings` with `add` appended: one new group per event and
 * matcher, at the end of that event's list, with the other keys untouched.
 */
export function addEntries(settings: Obj, add: readonly Entry[]): Obj {
  const next = structuredClone(settings);
  if (add.length === 0) return next;
  const hooks: Obj = isObj(next.hooks) ? next.hooks : {};
  next.hooks = hooks;
  const made = new Map<string, Obj>();
  for (const e of add) {
    const key = `${e.event}\n${e.matcher ?? ""}`;
    let group = made.get(key);
    if (!group) {
      group = e.matcher === null ? { hooks: [] } : { matcher: e.matcher, hooks: [] };
      made.set(key, group);
      // Checked as a list by parseSettings; the cast only widens it to append.
      const list = Array.isArray(hooks[e.event]) ? (hooks[e.event] as unknown[]) : [];
      hooks[e.event] = [...list, group];
    }
    hooksOf(group).push(structuredClone(e.hook));
  }
  return next;
}

// One group with the given commands taken out, and how many went; null when none were in it.
function strip(group: Obj, commands: ReadonlySet<string>, home: string): { group: Obj; gone: number } | null {
  const kept = hooksOf(group).filter(
    (h) => !(typeof h.command === "string" && commands.has(canonical(h.command, home))),
  );
  const gone = hooksOf(group).length - kept.length;
  return gone === 0 ? null : { group: { ...group, hooks: kept }, gone };
}

// One event's groups without the given commands, and how many hooks went.
function stripEvent(groups: readonly Obj[], commands: ReadonlySet<string>, home: string) {
  const kept: Obj[] = [];
  let removed = 0;
  for (const g of groups) {
    const s = strip(g, commands, home);
    if (!s) kept.push(g);
    else {
      removed += s.gone;
      if (hooksOf(s.group).length > 0) kept.push(s.group);
    }
  }
  return { kept, removed };
}

/**
 * A copy of `settings` without any hook running one of `commands`, on any
 * event and under any matcher, and how many hooks went. A group left with
 * no hooks goes, and an event left with no groups; the rest stays in order.
 */
export function removeCommands(settings: Obj, commands: readonly string[], home: string) {
  const next = structuredClone(settings);
  let removed = 0;
  if (!isObj(next.hooks)) return { settings: next, removed };
  const hooks = next.hooks;
  const wanted = new Set(commands.map((c) => canonical(c, home)));
  for (const [event, groups] of Object.entries(groupsOf(next))) {
    const s = stripEvent(groups, wanted, home);
    if (s.removed === 0) continue;
    removed += s.removed;
    if (s.kept.length === 0) delete hooks[event];
    else hooks[event] = s.kept;
  }
  return { settings: next, removed };
}

/** One line naming an entry, as setup lists what it will add. */
export const describe = (e: Entry): string => `${e.event}${e.matcher ? ` [${e.matcher}]` : ""}: ${e.command}`;
