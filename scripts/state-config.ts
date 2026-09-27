// The local state loop's contract (docs/state-loop.md): the shape of
// config/state.json, how one `set` from the sidebar changes it, and how the
// build reads it back. Shared by the URL handler (which writes) and build.ts
// (which injects __STATE__), and kept apart from both so it can be tested.
//
// Any web page can open a cmux-cockpit:// URL, so every value arriving here is
// untrusted: bad keys and values are refused, bad entries in the file are
// dropped, and nothing here ever throws on input.

export interface State {
  /** wsId -> agent id -> start of the needs_input spell that was dismissed (issue #5). */
  dismissed: Record<string, Record<string, number>>;
  /** wsId -> project key chosen by "Move to project" (issue #8). */
  projectOverride: Record<string, string>;
  /** match path -> a project made in the sidebar, merged over projects.json at build (issue #9). */
  projects: Record<string, ProjectSpec>;
}

/** A project made in the sidebar. Its match is the key it is stored under. */
export interface ProjectSpec {
  name: string;
  color: string;
  icon: string;
  root?: string;
}

export const emptyState = (): State => ({ dismissed: {}, projectOverride: {}, projects: {} });

// renderer.d.ts puts no shape on workspace or agent ids, and a project key is
// its first match path ("/dev/app"), so only length is bounded. Object
// prototype names are refused, so no entry can land on a prototype.
// Numeric-looking ids would sort first in Object.entries and so be evicted
// first; cmux ids are UUIDs, so that is accepted rather than worked round.
const RESERVED = new Set(["__proto__", "constructor", "prototype"]);
const isId = (v: string): boolean => v.length > 0 && v.length <= 128 && !RESERVED.has(v);
const MAX_PROJECT_KEY = 512;
/** Entries kept per map, so a flood of URLs cannot grow the file without bound. */
export const MAX_ENTRIES = 256;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

const isEpoch = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;

function agentStarts(v: unknown): Record<string, number> | null {
  if (!isRecord(v)) return null;
  const out: Record<string, number> = {};
  for (const [id, start] of Object.entries(v)) if (isId(id) && isEpoch(start)) out[id] = start;
  return Object.keys(out).length ? out : null;
}

const projectKey = (v: unknown): string | null =>
  typeof v === "string" && v.length > 0 && v.length <= MAX_PROJECT_KEY ? v : null;

// A sidebar-made project is keyed by its match: an absolute, lowercase
// directory, since directories are lowercased before matching.
const isMatchKey = (v: string): boolean =>
  v.startsWith("/") && v.length <= MAX_PROJECT_KEY && v === v.toLowerCase() && !RESERVED.has(v);

const isHex = (v: unknown): v is string => typeof v === "string" && /^#[0-9a-f]{6}$/i.test(v);
// SF Symbol names are dotted lowercase words, e.g. "music.note".
const isSymbol = (v: unknown): v is string =>
  typeof v === "string" && /^[a-z0-9]+(\.[a-z0-9]+)*$/.test(v) && v.length <= 64;
const isName = (v: unknown): v is string =>
  typeof v === "string" &&
  v.trim() === v &&
  v.length > 0 &&
  v.length <= 64 &&
  [...v].every((c) => c.charCodeAt(0) >= 32);

function projectSpec(v: unknown): ProjectSpec | null {
  if (!isRecord(v) || !isName(v.name) || !isHex(v.color) || !isSymbol(v.icon)) return null;
  const spec: ProjectSpec = { name: v.name, color: v.color, icon: v.icon };
  if (v.root === undefined) return spec;
  return typeof v.root === "string" && isMatchKey(v.root.toLowerCase()) ? { ...spec, root: v.root } : null;
}

// Keeps the last MAX_ENTRIES valid entries, in insertion order.
function cleanMap<T>(v: unknown, clean: (value: unknown) => T | null, validId = isId): Record<string, T> {
  if (!isRecord(v)) return {};
  const kept = Object.entries(v).flatMap(([id, value]): [string, T][] => {
    const c = validId(id) ? clean(value) : null;
    return c === null ? [] : [[id, c]];
  });
  return Object.fromEntries(kept.slice(-MAX_ENTRIES));
}

/** Reads whatever is in the file into a State, dropping anything malformed. */
export function validateState(raw: unknown): State {
  const v = isRecord(raw) ? raw : {};
  return {
    dismissed: cleanMap(v.dismissed, agentStarts),
    projectOverride: cleanMap(v.projectOverride, projectKey),
    projects: cleanMap(v.projects, projectSpec, isMatchKey),
  };
}

export type SetResult = { ok: true; state: State } | { ok: false; error: string };

type MapName = keyof State;
const MAPS: readonly MapName[] = ["dismissed", "projectOverride", "projects"];
const isMapName = (v: string): v is MapName => (MAPS as readonly string[]).includes(v);

function without<T>(entries: Record<string, T>, id: string): Record<string, T> {
  const next = { ...entries };
  delete next[id];
  return next;
}

// One case per map, so each keeps its own entry type.
function withoutEntry(state: State, map: MapName, id: string): State {
  switch (map) {
    case "dismissed":
      return { ...state, dismissed: without(state.dismissed, id) };
    case "projectOverride":
      return { ...state, projectOverride: without(state.projectOverride, id) };
    case "projects":
      return { ...state, projects: without(state.projects, id) };
  }
}

// Adds one parsed entry, or says what the map wanted instead.
function withEntry(state: State, map: MapName, id: string, parsed: unknown): State | string {
  switch (map) {
    case "dismissed": {
      const starts = agentStarts(parsed);
      return starts
        ? { ...state, dismissed: { ...state.dismissed, [id]: starts } }
        : "dismissed wants {agentId: epoch}";
    }
    case "projectOverride": {
      const key = projectKey(parsed);
      return key
        ? { ...state, projectOverride: { ...state.projectOverride, [id]: key } }
        : "projectOverride wants a project key string";
    }
    case "projects": {
      const spec = projectSpec(parsed);
      return spec
        ? { ...state, projects: { ...state.projects, [id]: spec } }
        : "projects wants {name, color: #rrggbb, icon: SF Symbol, root?}";
    }
  }
}

/**
 * Applies one `set`: `key` is `<map>.<id>`, `value` the JSON for that entry,
 * or null to delete it. The id is a workspace id, or for `projects` the
 * project's match path. Returns a new State; the input is not changed.
 */
export function applySet(state: State, key: string, value: string | null): SetResult {
  const dot = key.indexOf(".");
  const map = key.slice(0, dot);
  const id = key.slice(dot + 1);
  if (dot < 1) return { ok: false, error: `bad key ${JSON.stringify(key)}` };
  if (!isMapName(map)) return { ok: false, error: `unknown map ${map}` };
  if (!(map === "projects" ? isMatchKey(id) : isId(id))) return { ok: false, error: `bad key ${JSON.stringify(key)}` };

  const cleared = withoutEntry(state, map, id);
  if (value === null) return { ok: true, state: cleared };

  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return { ok: false, error: "value is not JSON" };
  }
  const next = withEntry(cleared, map, id, parsed);
  return typeof next === "string" ? { ok: false, error: next } : { ok: true, state: validateState(next) };
}
