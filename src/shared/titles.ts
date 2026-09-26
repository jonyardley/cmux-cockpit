// Display titles that tell workspaces apart (issue #32).
//
// Terminal workspaces are often titled by their shell's directory, so five of
// them can all read "~/Dev". When two or more workspaces would show the same
// title, each gains path segments from its own directory until the titles
// differ: "~/Dev" becomes "~/Dev/cmux-cockpit". A title that is not a path
// takes the directory's trailing segments as a suffix instead
// ("Claude Code · cmux-cockpit"). Only when the directories also match does a
// number go on ("~/Dev 2"). Titles that do not collide are left as they are.

import { cleanTitle } from "./text.ts";

// Between a non-path title and its directory suffix.
const SUFFIX_SEP = " · ";

interface Item {
  id: string;
  title: string;
  /** Normalised directory: home as "~", no trailing slash. */
  dir: string;
  /** Segments that extend the title, or null when the title is not a path over dir. */
  rest: string[] | null;
  /** The directory's segments, for the suffix form. */
  segs: string[];
}

// "/Users/jon/Dev/x/" and "/home/jon/Dev/x" both read "~/Dev/x".
// /Users/Shared is not anyone's home, so it stays as it is.
function normaliseDir(directory: string | null | undefined): string {
  return String(directory ?? "")
    .trim()
    .replace(/^\/(?:Users\/(?!Shared(?:\/|$))|home\/)[^/]+(?=\/|$)/, "~")
    .replace(/(.)\/+$/, "$1");
}

// The directory's segments below a path title, or null when the title is not
// that directory or one of its ancestors. macOS paths are case-insensitive.
function restBelow(title: string, dir: string): string[] | null {
  if (!dir || !/^[~/]/.test(title)) return null;
  const t = title.replace(/(.)\/+$/, "$1").toLowerCase();
  const d = dir.toLowerCase();
  if (d === t) return [];
  const prefix = t.endsWith("/") ? t : t + "/";
  if (!d.startsWith(prefix)) return null;
  return dir.slice(prefix.length).split("/").filter(Boolean);
}

function toItem(w: Workspace): Item {
  const title = cleanTitle(w.title);
  const dir = normaliseDir(w.directory);
  return { id: w.id, title, dir, rest: restBelow(title, dir), segs: dir.split("/").filter(Boolean) };
}

// The title with `depth` segments of the item's directory added.
function labelAt(it: Item, depth: number): string {
  if (depth === 0 || !it.dir) return it.title;
  if (it.rest) {
    const extra = it.rest.slice(0, depth);
    return extra.length ? it.title.replace(/\/+$/, "") + "/" + extra.join("/") : it.title;
  }
  return it.title + SUFFIX_SEP + it.segs.slice(-depth).join("/");
}

function depthLimit(it: Item): number {
  return it.rest ? it.rest.length : it.segs.length;
}

function groupBy(items: Item[], key: (it: Item) => string): Map<string, Item[]> {
  const out = new Map<string, Item[]>();
  for (const it of items) {
    const k = key(it);
    const g = out.get(k);
    if (g) g.push(it);
    else out.set(k, [it]);
  }
  return out;
}

// Items that share a label: go one segment deeper until each stands alone, or
// number them once more segments cannot help (same directory, or none left).
function resolve(items: Item[], depth: number, out: Map<string, string>, taken: ReadonlySet<string>): void {
  for (const [label, group] of groupBy(items, (it) => labelAt(it, depth))) {
    if (group.length === 1) {
      for (const it of group) out.set(it.id, label);
      continue;
    }
    const sameDir = group.every((it) => it.dir === group[0]?.dir);
    const exhausted = group.every((it) => depthLimit(it) <= depth);
    if (sameDir || exhausted) number(group, label, out, taken);
    else resolve(group, depth + 1, out, taken);
  }
}

// The first keeps the plain label, the rest count up from 2, stepping over any
// number that is already another workspace's own title. The group arrives in
// id order, so a workspace keeps its number however the list is sorted.
function number(group: Item[], label: string, out: Map<string, string>, taken: ReadonlySet<string>): void {
  let n = 1;
  for (const it of group) {
    if (n === 1) {
      out.set(it.id, label);
      n++;
      continue;
    }
    while (taken.has(label + " " + n)) n++;
    out.set(it.id, label + " " + n);
    n++;
  }
}

// A lengthened title can land on another workspace's own title ("~/Dev" in
// cmux-cockpit becoming "~/Dev/cmux-cockpit" beside a workspace already titled
// that): the workspace whose own title it is keeps it, and the lengthened ones
// are numbered, in id order.
function settleClashes(items: readonly Item[], out: Map<string, string>): void {
  const owns = (it: Item): boolean => out.get(it.id) === it.title;
  const order = [...items.filter(owns), ...items.filter((it) => !owns(it))];
  const taken = new Set<string>();
  for (const it of order) {
    const label = out.get(it.id) ?? "";
    let final = label;
    for (let n = 2; label && taken.has(final); n++) final = label + " " + n;
    taken.add(final);
    out.set(it.id, final);
  }
}

const byId = (a: Item, b: Item): number => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * A display title per workspace id: cleanTitle(), made unique across the list.
 * Empty titles stay empty so each view keeps its own fallback copy.
 */
export function displayTitles(workspaces: readonly Workspace[]): Map<string, string> {
  const items = workspaces.map(toItem);
  const out = new Map<string, string>();
  for (const it of items) if (!it.title) out.set(it.id, "");
  // Id order, not list order, so numbers stay with their workspace.
  const titled = items.filter((it) => it.title).sort(byId);
  resolve(titled, 0, out, new Set(titled.map((it) => it.title)));
  settleClashes(titled, out);
  return out;
}

// Worked out once per change to the workspace list, not once per row.
const titleMap = computed(() => displayTitles(data.workspaces() ?? []));

/** The workspace's display title among everything cmux currently shows. */
export function displayTitle(w: Workspace | null | undefined): string {
  if (!w) return "";
  return titleMap().get(w.id) ?? cleanTitle(w.title);
}
