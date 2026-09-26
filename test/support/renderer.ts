// A stand-in for the cmux renderer, so sidebar code runs under node:test.
//
// Views are chainable no-ops, but every reactive argument (a zero-argument
// function) is called and every ForEach renders its items, so view closures
// run against the fixture data. Tap and move handlers are recorded, never
// fired. Install before importing any sidebar module: modules create their
// signals at import time.

import { readFileSync } from "node:fs";
import vm from "node:vm";

// Sidebar modules read PROJECTS from this define at import time (build.ts
// injects it for real; tests stand in the example table instead).
const EXAMPLE_PROJECTS: unknown = JSON.parse(readFileSync("config/projects.example.json", "utf8"));
(globalThis as Record<string, unknown>).__PROJECTS__ = EXAMPLE_PROJECTS;

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

function view(): View {
  const node: View = new Proxy(() => undefined, {
    get: (_target, prop) => {
      return (...args: unknown[]) => {
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
      evaluate(label);
      return menuItem();
    },
    Menu: menuItem,
    Divider: menuItem,
    signal: <T>(initial: T) => {
      let value = initial;
      return [() => value, (next: T) => (value = next)];
    },
    // No memo: every read recomputes, which is what a test wants.
    computed: <T>(fn: () => T) => fn,
    sidebar: (root: () => unknown) => {
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
  // The build inlines the real __PROJECTS__ literal, so this is only a
  // fallback for a bundle built without that define.
  const context = vm.createContext({ __PROJECTS__: EXAMPLE_PROJECTS, ...r.globals });
  vm.runInContext(readFileSync(file, "utf8"), context, { filename: file });
}
