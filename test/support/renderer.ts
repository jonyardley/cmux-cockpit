// A stand-in for the cmux renderer, so sidebar code runs under node:test.
//
// Views are chainable no-ops, but every reactive argument (a zero-argument
// function) is called and every ForEach renders its items, so view closures
// run against the fixture data. Tap and move handlers are recorded, never
// fired. Install before importing any sidebar module: modules create their
// signals at import time. `sidebar()` builds its root on the spot, as cmux
// does, so a bundle that uses a helper before declaring it fails here (#87).

import { readFileSync } from "node:fs";
import vm from "node:vm";
import { emptyState } from "../../scripts/state-config.ts";

// Sidebar modules read PROJECTS from this define at import time (build.ts
// injects it for real; tests stand in the example table instead). As with
// __STATE__ below, a test file can seed its own table before importing this.
const EXAMPLE_PROJECTS: unknown = JSON.parse(readFileSync("config/projects.example.json", "utf8"));
if (!("__PROJECTS__" in (globalThis as Record<string, unknown>))) {
  (globalThis as Record<string, unknown>).__PROJECTS__ = EXAMPLE_PROJECTS;
}

// Same story for __STATE__, but defaulting to empty rather than a fixture:
// most tests have nothing saved. A test that wants a saved state sets
// globalThis.__STATE__ itself, in a file of its own, before dynamically
// importing this module (a static import here would already have set the
// default by the time that assignment ran).
const EMPTY_STATE = emptyState();
if (!("__STATE__" in (globalThis as Record<string, unknown>))) {
  (globalThis as Record<string, unknown>).__STATE__ = EMPTY_STATE;
}

export interface FakeData {
  workspaces: Workspace[];
  groups: WorkspaceGroup[];
  epoch: number;
  selectedId: string | null;
}

export interface Renderer {
  data: FakeData;
  /** Every cmux() dispatch, in order. */
  calls: { method: string; params: Record<string, unknown> }[];
  opened: string[];
  /** Every menu item built, as "button:<label>" or "divider". */
  menu: string[];
  roots: (() => View)[];
  globals: Record<string, unknown>;
}

const HANDLERS = new Set(["onTap"]);

/**
 * One node of a built view tree, as test/support/snapshot.ts prints it: the
 * builder, its own arguments (a Text's words, a stack's spacing) and its
 * modifiers in call order, each with its reactive values read once.
 */
export interface ViewNode {
  kind: string;
  args: unknown[];
  mods: { name: string; values: unknown[] }[];
  children: ViewNode[];
  /** Tap handlers by modifier name, so a test can fire one; never printed. */
  handlers: Record<string, unknown>;
}

// Each fake view's node, keyed by the proxy the sidebar code holds.
const nodes = new WeakMap<object, ViewNode>();

/** The node behind a view the fake renderer built, or undefined for anything else. */
export const nodeOf = (v: unknown): ViewNode | undefined => (typeof v === "function" ? nodes.get(v) : undefined);
/** Every node in the tree with a tap handler, in drawing order. */
/** A node's first value for modifier `name`, read now if it is reactive; undefined when the modifier is not there. */
export function modValue(n: ViewNode | undefined, name: string): unknown {
  const v = n?.mods.find((m) => m.name === name)?.values[0];
  return typeof v === "function" ? v() : v;
}

export const taps = (n: ViewNode): ViewNode[] => [
  ...(typeof n.handlers.onTap === "function" ? [n] : []),
  ...n.children.flatMap(taps),
];

// A reactive argument's current value: a zero-argument function is called
// (so view closures run against the fixture data), an options object has
// each field read the same way, and handlers ("on...") are left unread.
function resolve(arg: unknown): unknown {
  if (typeof arg === "function") return arg.length === 0 ? arg() : undefined;
  if (arg && typeof arg === "object" && !Array.isArray(arg)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(arg)) if (!k.startsWith("on")) out[k] = resolve(v);
    return out;
  }
  return arg;
}

// The modifier log while recordModifiers() runs, and null the rest of the time.
let modifierLog: string[] | null = null;

/**
 * Every modifier called on any view while `build` runs, in call order, for a
 * test that cares about their order (a frame before a background). Nothing
 * is recorded outside it.
 */
export function recordModifiers(build: () => void): string[] {
  const log: string[] = [];
  modifierLog = log;
  try {
    build();
  } finally {
    modifierLog = null;
  }
  return log;
}

function view(kind: string, args: unknown[] = [], children: readonly unknown[] = []): View {
  const node: ViewNode = { kind, args, mods: [], children: children.flatMap((c) => nodeOf(c) ?? []), handlers: {} };
  const proxy: View = new Proxy(() => undefined, {
    get: (_target, prop) => {
      return (...margs: unknown[]) => {
        const name = String(prop);
        modifierLog?.push(name);
        // A context menu is recorded by its length: its items are opaque.
        let values: unknown[] = [];
        if (name === "contextMenu") values = [Array.isArray(margs[0]) ? margs[0].length : 0];
        else if (HANDLERS.has(name)) node.handlers[name] = margs[0];
        else values = margs.map(resolve);
        node.mods.push({ name, values });
        return proxy;
      };
    },
    // Every property is a chainable modifier, so the proxy satisfies View.
  }) as unknown as View;
  nodes.set(proxy, node);
  return proxy;
}

// MenuItem is an opaque brand: the renderer never reads it back.
const menuItem = () => ({}) as MenuItem;

const list =
  (kind: string) =>
  <T>(options: ForEachOptions<T>, render: (item: () => T) => View): View => {
    const rows: View[] = [];
    for (const item of options.items()) {
      options.key(item);
      rows.push(render(() => item));
    }
    // A Reorderable's row spacing is on screen; its keys and handlers are not.
    const spacing = "spacing" in options ? options.spacing : undefined;
    return view(kind, spacing === undefined ? [] : [{ spacing }], rows);
  };

// A leaf's arguments are its content or options; a stack's array argument
// is its children, which become the node's children instead.
const builder =
  (kind: string) =>
  (...args: unknown[]): View => {
    const own = args.filter((a) => !Array.isArray(a)).map(resolve);
    const children: unknown = args.find(Array.isArray);
    return view(kind, own, Array.isArray(children) ? children : []);
  };

export function createRenderer(): Renderer {
  const r: Renderer = {
    data: { workspaces: [], groups: [], epoch: 1_000_000, selectedId: null },
    calls: [],
    opened: [],
    menu: [],
    roots: [],
    globals: {},
  };
  r.globals = {
    VStack: builder("VStack"),
    HStack: builder("HStack"),
    ZStack: builder("ZStack"),
    Text: builder("Text"),
    Image: builder("Image"),
    Spacer: builder("Spacer"),
    Circle: builder("Circle"),
    Rectangle: builder("Rectangle"),
    RoundedRectangle: builder("RoundedRectangle"),
    ProgressView: builder("ProgressView"),
    ForEach: list("ForEach"),
    Reorderable: list("Reorderable"),
    // Its handlers are kept on the node, so a test can type into it.
    TextField: (value: Reactive<string>, options: TextFieldOptions = {}) => {
      const { onEdit, onCancel, ...shown } = options;
      const field = view("TextField", [resolve(value), shown]);
      const node = nodeOf(field);
      if (node) Object.assign(node.handlers, { onEdit, onCancel });
      return field;
    },
    Button: (label: Reactive<string>) => {
      r.menu.push("button:" + (typeof label === "function" ? label() : label));
      return menuItem();
    },
    Divider: () => {
      r.menu.push("divider");
      return menuItem();
    },
    signal: <T>(initial: T) => {
      let value = initial;
      return [() => value, (next: T) => (value = next)];
    },
    // No memo: every read recomputes, which is what a test wants. It runs
    // once on definition, as the real renderer does, so a read of state
    // declared further down the module fails here too.
    computed: <T>(fn: () => T) => {
      fn();
      return fn;
    },
    // cmux builds the root as soon as it is registered, before the rest of
    // the script has run, so a view helper declared further down fails
    // here too, as it does in the app.
    sidebar: (root: () => View) => {
      root();
      r.roots.push(root);
    },
    cmux: (method: string, params: Record<string, unknown>) => {
      r.calls.push({ method, params });
    },
    openURL: (url: string) => {
      r.opened.push(url);
    },
    data: {
      workspaces: () => r.data.workspaces,
      groups: () => r.data.groups,
      clock: () => ({ epoch: r.data.epoch }),
      selectedId: () => r.data.selectedId,
    },
  };
  return r;
}

/** Installs a renderer on globalThis for importing src modules directly. */
export function installRenderer(): Renderer {
  const r = createRenderer();
  Object.assign(globalThis, r.globals);
  return r;
}

/** Runs a built sidebars/*.js file the way cmux does: one flat script. */
export function runBuilt(file: string, r: Renderer): void {
  // The build inlines the real __PROJECTS__ and __STATE__ literals, so this
  // is only a fallback for a bundle built without those defines.
  const context = vm.createContext({ __PROJECTS__: EXAMPLE_PROJECTS, __STATE__: EMPTY_STATE, ...r.globals });
  vm.runInContext(readFileSync(file, "utf8"), context, { filename: file });
}
