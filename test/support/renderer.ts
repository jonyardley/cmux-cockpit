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
  roots: (() => unknown)[];
  globals: Record<string, unknown>;
}

const HANDLERS = new Set(["onTap"]);

function evaluate(arg: unknown): void {
  if (typeof arg === "function") {
    if (arg.length === 0) arg();
    return;
  }
  if (arg && typeof arg === "object" && !Array.isArray(arg)) {
    for (const [k, v] of Object.entries(arg)) if (!k.startsWith("on")) evaluate(v);
  }
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

function view(): View {
  const node: View = new Proxy(() => undefined, {
    get: (_target, prop) => {
      return (...args: unknown[]) => {
        modifierLog?.push(String(prop));
        if (!HANDLERS.has(String(prop))) for (const a of args) evaluate(a);
        return node;
      };
    },
    // Every property is a chainable modifier, so the proxy satisfies View.
  }) as unknown as View;
  return node;
}

// MenuItem is an opaque brand: the renderer never reads it back.
const menuItem = () => ({}) as MenuItem;

function list<T>(options: ForEachOptions<T>, render: (item: () => T) => View): View {
  for (const item of options.items()) {
    options.key(item);
    render(() => item);
  }
  return view();
}

export function createRenderer(): Renderer {
  const r: Renderer = {
    data: { workspaces: [], groups: [], epoch: 1_000_000, selectedId: null },
    calls: [],
    opened: [],
    menu: [],
    roots: [],
    globals: {},
  };
  const builder = (...args: unknown[]) => {
    for (const a of args) if (!Array.isArray(a)) evaluate(a);
    return view();
  };
  r.globals = {
    VStack: builder,
    HStack: builder,
    ZStack: builder,
    Text: builder,
    Image: builder,
    Spacer: builder,
    Circle: builder,
    Rectangle: builder,
    RoundedRectangle: builder,
    ProgressView: builder,
    ForEach: list,
    Reorderable: list,
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
    sidebar: (root: () => unknown) => {
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
