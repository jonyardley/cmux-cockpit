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
}

export const emptyState = (): State => ({ dismissed: {}, projectOverride: {} });

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

// Keeps the last MAX_ENTRIES valid entries, in insertion order.
function cleanMap<T>(v: unknown, clean: (value: unknown) => T | null): Record<string, T> {
  if (!isRecord(v)) return {};
  const kept = Object.entries(v).flatMap(([id, value]): [string, T][] => {
    const c = isId(id) ? clean(value) : null;
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
  };
}

export type SetResult = { ok: true; state: State } | { ok: false; error: string };

/**
 * Applies one `set`: `key` is `<map>.<wsId>`, `value` the JSON for that entry,
 * or null to delete it. Returns a new State; the input is not changed.
 */
export function applySet(state: State, key: string, value: string | null): SetResult {
  const dot = key.indexOf(".");
  const map = key.slice(0, dot);
  const id = key.slice(dot + 1);
  if (dot < 1 || !isId(id)) return { ok: false, error: `bad key ${JSON.stringify(key)}` };
  if (map !== "dismissed" && map !== "projectOverride") return { ok: false, error: `unknown map ${map}` };

  const next: State = { dismissed: { ...state.dismissed }, projectOverride: { ...state.projectOverride } };
  delete next[map][id];
  if (value === null) return { ok: true, state: next };

  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return { ok: false, error: "value is not JSON" };
  }
  if (map === "dismissed") {
    const starts = agentStarts(parsed);
    if (!starts) return { ok: false, error: "dismissed wants {agentId: epoch}" };
    next.dismissed[id] = starts;
  } else {
    const project = projectKey(parsed);
    if (!project) return { ok: false, error: "projectOverride wants a project key string" };
    next.projectOverride[id] = project;
  }
  return { ok: true, state: validateState(next) };
}
