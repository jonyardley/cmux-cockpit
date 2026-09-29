// Text snapshots of a whole sidebar (npm run snapshots re-records them).
//
// A scene seeds the saved state and project table, loads one sidebar under
// the fake renderer, sets its fixture data and prints the root as indented
// text: each element with its words, its colours as theme token names, and
// its modifiers (spacing, padding, font) in call order. A panel hidden at
// zero height prints as one line. The text lives in test/__snapshots__/,
// one file per scene; any drift fails the test with a diff, which is also
// what a PR's "What changed on screen" section is filled from.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { emptyState, type State } from "../../scripts/state-config.ts";
import { NEUTRAL_CHIP, prInk, READY_INK } from "../../src/shared/pr-colors.ts";
import { installRenderer, nodeOf, type Renderer, type ViewNode } from "./renderer.ts";

const DIR = "test/__snapshots__";
const UPDATE = process.env.UPDATE_SNAPSHOTS === "1";

/** A fixed clock for every scene, so ages print the same on every run. */
export const EPOCH = 1_000_000;

/** Epoch seconds `secs` before the scene's clock. */
export const ago = (secs: number): number => EPOCH - secs;

// Colour tokens: hex (upper case) -> every token name that holds it, in
// declaration order, so an alias ("laneMain|select|heading") reads as such.
type Tokens = Map<string, string[]>;

function tokenMap(tables: Record<string, string>[]): Tokens {
  const out: Tokens = new Map();
  for (const table of tables) {
    for (const [name, hex] of Object.entries(table)) {
      if (!hex.startsWith("#")) continue;
      const k = hex.toUpperCase();
      const names = out.get(k) ?? [];
      if (!names.includes(name)) names.push(name);
      out.set(k, names);
    }
  }
  return out;
}

// Every token name printed during one render(), with its hex, for the
// scene's colour key: a token whose value changes then shows as drift too.
const used = new Map<string, string>();

// A token's name; a faint variant ("#788C5D1F" with no token of its own) as
// its hue and alpha ("green@1F"); anything else, a project colour say, as is.
function colourName(hex: string, tokens: Tokens): string {
  const k = hex.toUpperCase();
  const named = tokens.get(k);
  if (named) {
    used.set(named.join("|"), k);
    return named.join("|");
  }
  const base = k.length === 9 ? tokens.get(k.slice(0, 7)) : undefined;
  if (!base) return hex;
  used.set(base.join("|"), k.slice(0, 7));
  return `${base.join("|")}@${k.slice(7)}`;
}

const isHex = (v: unknown): v is string => typeof v === "string" && /^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(v);

// A value as it prints: a colour by its token, a word bare ("leading"),
// other text quoted, an options object as "key: value" pairs.
function value(v: unknown, tokens: Tokens): string {
  if (isHex(v)) return colourName(v, tokens);
  if (typeof v === "string") return /^[\w.-]+$/.test(v) ? v : JSON.stringify(v);
  if (v && typeof v === "object") {
    return Object.entries(v)
      .map(([k, x]) => `${k}: ${value(x, tokens)}`)
      .join(", ");
  }
  return String(v);
}

// A Text's words quoted, with any space other than a plain one escaped: a
// tracked heading's hair spaces (text.ts) would otherwise read as plain.
const words = (s: string): string =>
  JSON.stringify(s).replace(/[^\S ]/gu, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);

// A builder's own arguments: a Text's words always quoted, so "" and "5m"
// read as words; options as pairs; an empty options object left out.
function args(n: ViewNode, tokens: Tokens): string[] {
  return n.args.flatMap((a) => {
    if (a === undefined) return [];
    if (typeof a === "string" && n.kind === "Text") return [words(a)];
    const text = value(a, tokens);
    return text ? [text] : [];
  });
}

const zeroHeight = (v: unknown): boolean => !!v && typeof v === "object" && "maxHeight" in v && v.maxHeight === 0;

// Hidden by model.ts's panelOpacity and panelMaxHeight: nothing of it is on
// screen. The last opacity wins, and any zero-height frame clips it.
function isHidden(n: ViewNode): boolean {
  const opacity = n.mods.findLast((m) => m.name === "opacity")?.values[0];
  return opacity === 0 && n.mods.some((m) => m.name === "frame" && zeroHeight(m.values[0]));
}

// ForEach and Reorderable are structure, not something on screen: an empty
// one (a when() that is off) prints nothing, and a full one's rows print at
// its own level unless the list itself carries spacing or a modifier.
const isList = (n: ViewNode): boolean => n.kind === "ForEach" || n.kind === "Reorderable";

function print(n: ViewNode, depth: number, tokens: Tokens, out: string[]): void {
  if (isList(n) && (!n.children.length || (!n.mods.length && !n.args.length))) {
    for (const c of n.children) print(c, depth, tokens, out);
    return;
  }
  const mods = n.mods.map((m) => `.${m.name}(${m.values.map((v) => value(v, tokens)).join(", ")})`);
  const hidden = isHidden(n);
  out.push("  ".repeat(depth) + [n.kind, ...args(n, tokens), ...mods, ...(hidden ? ["[hidden]"] : [])].join(" "));
  if (hidden) return;
  for (const c of n.children) print(c, depth + 1, tokens, out);
}

// The chips' colours that pr-colors.ts keeps as values rather than
// tokens: ready's and failing's inks (running and grey are the palette's
// blueText and metaText), and the branch and ports chips' neutral pill
// ("neutralChip.bg").
function chipTokens(): Record<string, string> {
  return {
    readyInk: READY_INK,
    failingInk: prInk("failing"),
    "neutralChip.bg": NEUTRAL_CHIP.bg,
    "neutralChip.fg": NEUTRAL_CHIP.fg,
    "neutralChip.edge": NEUTRAL_CHIP.edge,
  };
}

/** The view tree under `root` as indented text, colours named from `tables`. */
function render(root: ViewNode, tables: Record<string, string>[]): string {
  const out: string[] = [];
  used.clear();
  print(root, 0, tokenMap(tables), out);
  const key = [...used].sort(([a], [b]) => a.localeCompare(b)).map(([name, hex]) => `${name} ${hex}`);
  return [...out, "", "Colours", ...key].join("\n") + "\n";
}

// The lines that differ, saved ("-") then now ("+"), between the common
// head and tail, with the first one's line number. assert's own diff
// clips long lines, and a snapshot line is often long.
function lineDiff(saved: string, now: string): string {
  const a = saved.split("\n");
  const b = now.split("\n");
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a.at(-1 - tail) === b.at(-1 - tail)) tail++;
  const gone = a.slice(head, a.length - tail).map((l) => "- " + l);
  const added = b.slice(head, b.length - tail).map((l) => "+ " + l);
  return [`at line ${head + 1}:`, ...gone, ...added].join("\n");
}

/** Fails on any drift from the scene's saved text; UPDATE_SNAPSHOTS=1 re-records it instead. */
function matchSnapshot(scene: string, text: string): void {
  const file = `${DIR}/${scene}.txt`;
  if (UPDATE) {
    mkdirSync(DIR, { recursive: true });
    writeFileSync(file, text);
    return;
  }
  assert.ok(existsSync(file), `${file} is missing: run npm run snapshots to record it`);
  const saved = readFileSync(file, "utf8");
  if (text !== saved)
    assert.fail(`${scene} changed on screen; if that is meant, run npm run snapshots\n${lineDiff(saved, text)}`);
}

interface Seed {
  state?: Partial<State>;
  /** The project table (__PROJECTS__); the example table when left out. */
  projects?: unknown[];
}

/**
 * Seeds the saved state and projects over renderer.ts's defaults, then
 * installs the fake renderer. Call before importing the sidebar, which
 * reads both at load.
 */
export function seed({ state = {}, projects }: Seed = {}): Renderer {
  // The build defines these as globals; tests stand them in on globalThis.
  const g = globalThis as Record<string, unknown>;
  g.__STATE__ = { ...emptyState(), ...state };
  if (projects) g.__PROJECTS__ = projects;
  const r = installRenderer();
  r.data.epoch = EPOCH;
  return r;
}

/**
 * Builds the sidebar's root afresh against the current fixture data and
 * checks it against the scene's saved text. `theme` is the sidebar's own
 * token table (C or T), named ahead of the chip colours.
 */
export function snapshotScene(scene: string, r: Renderer, theme: Record<string, string>): void {
  const root = r.roots.at(-1);
  assert.ok(root, "no sidebar registered: import the sidebar before snapshotting it");
  const node = nodeOf(root());
  assert.ok(node, "the root is not a view the fake renderer built");
  matchSnapshot(scene, render(node, [theme, chipTokens()]));
}
