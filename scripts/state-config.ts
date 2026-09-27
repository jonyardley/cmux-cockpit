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
  /**
   * wsId -> the pull request for the workspace's branch, found by
   * scripts/pr-poll.ts because cmux sends custom sidebars none (issue #7).
   * Written only by the poller, never by a URL: a URL could plant a link.
   */
  prs: Record<string, SavedPr>;
  /**
   * wsId -> the workspace's subagent runs, oldest first, recorded by
   * scripts/hooks/report-subagent.ts because cmux sends custom sidebars none
   * (issue #6). Written only by the hook, never by a URL.
   */
  subagents: Record<string, SavedSubagent[]>;
  /** The cockpit's view and what is folded, so a rebuild's reload keeps them. */
  ui: UiState;
}

export type ViewMode = "all" | "projects";

/**
 * The cockpit's own view state. Each rebuild hot-reloads the sidebar, which
 * would otherwise land back on All with everything unfolded.
 */
export interface UiState {
  mode?: ViewMode;
  /** "lane:<key>" or "project:<key>" -> 1 folded, 0 unfolded. */
  collapsed?: Record<string, number>;
}

/** A project made in the sidebar. Its match is the key it is stored under. */
export interface ProjectSpec {
  name: string;
  color: string;
  icon: string;
  root?: string;
}

/** A pull request as the poller saves it, shaped like renderer.d.ts's PullRequest. */
export interface SavedPr {
  number: number;
  url: string;
  status: "open" | "merged" | "closed";
  branch: string;
  /** Set only while the PR is a draft, so a ready PR's entry is unchanged. */
  draft?: true;
  /**
   * Set only while GitHub says the PR can merge as it stands
   * (mergeStateStatus "CLEAN": no conflicts, no blocking review or check).
   */
  mergeable?: true;
  /** Its CI checks, failing first (pr-poll.ts's checksFrom); left out when it has none. */
  checks?: SavedCheck[];
}

/**
 * One CI check, cut down to three states so only a real change of state
 * (never a timestamp or a rerun's id) rewrites the file and rebuilds.
 */
export interface SavedCheck {
  name: string;
  state: CheckState;
}

export type CheckState = "pass" | "fail" | "pending";

/**
 * A subagent run as the hook saves it, shaped like renderer.d.ts's
 * SubagentRun. Its entry is made when the Agent tool is called, before the
 * run has an agent id, so it is keyed by the call instead.
 */
export interface SavedSubagent {
  /** The Agent tool call's tool_use_id. */
  id: string;
  /** The Claude Code session that called it. */
  session: string;
  /** Claude Code's agent_id, set when the run starts; SubagentStop names it. */
  agentId?: string;
  /** The Agent call's tool_input.subagent_type, so a SubagentStart with
   * several unpaired calls in the same session pairs to the right one. */
  type?: string;
  /** The Agent call's description, at most MAX_LABEL characters. */
  label: string;
  /** Epoch seconds the Agent tool was called. */
  startedEpoch: number;
  /** Epoch seconds the run stopped; absent while it runs. */
  endedEpoch?: number;
}

/** Runs kept per workspace, newest kept, so a busy agent cannot bloat the file. */
export const MAX_SUBAGENTS = 10;
/** The longest label kept; the hook cuts a description to this. */
export const MAX_LABEL = 120;

/** Checks kept per PR, so one PR with a huge matrix cannot bloat the file. */
export const MAX_CHECKS = 20;

export const emptyState = (): State => ({
  dismissed: {},
  projectOverride: {},
  projects: {},
  prs: {},
  subagents: {},
  ui: {},
});

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

export const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

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
// directory ending in "/", so it matches that folder and no sibling that
// shares its prefix (projectOf adds the same "/" to the directory). At least
// two segments deep, so no URL can plant a "/" that swallows every folder.
const isMatchKey = (v: string): boolean =>
  /^(\/[^/]+){2,}\/$/.test(v) && v.length <= MAX_PROJECT_KEY && v === v.toLowerCase();

const isHex = (v: unknown): v is string => typeof v === "string" && /^#[0-9a-f]{6}$/i.test(v);
// SF Symbol names are dotted lowercase words, e.g. "music.note".
const isSymbol = (v: unknown): v is string =>
  typeof v === "string" && /^[a-z0-9]+(\.[a-z0-9]+)*$/.test(v) && v.length <= 64;

// A control character, 0-31 or 127 (DEL): the same rule the hook's own
// dropControl uses (scripts/hooks/report-subagent.ts), so a label that
// reads as clean there reads as clean here too.
const isCleanChar = (c: string): boolean => {
  const code = c.charCodeAt(0);
  return code >= 32 && code !== 127;
};

// Plain, single-line text with no leading, trailing or control characters,
// up to `max` long. Shared by isName and isLabel so both keep one rule.
function isText(v: unknown, max: number): v is string {
  return typeof v === "string" && v.trim() === v && v.length > 0 && v.length <= max && [...v].every(isCleanChar);
}

const isName = (v: unknown): v is string => isText(v, 64);

function projectSpec(v: unknown): ProjectSpec | null {
  if (!isRecord(v) || !isName(v.name) || !isHex(v.color) || !isSymbol(v.icon)) return null;
  const spec: ProjectSpec = { name: v.name, color: v.color, icon: v.icon };
  if (v.root === undefined) return spec;
  const root = v.root;
  return typeof root === "string" && root.startsWith("/") && root.length <= MAX_PROJECT_KEY ? { ...spec, root } : null;
}

// Only a GitHub pull request page, since the sidebar opens it on a tap.
const isPrUrl = (v: unknown): v is string =>
  typeof v === "string" && v.length <= 512 && /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+$/.test(v);
const PR_STATUSES: readonly unknown[] = ["open", "merged", "closed"];
const isPrStatus = (v: unknown): v is SavedPr["status"] => PR_STATUSES.includes(v);

const CHECK_STATES: readonly unknown[] = ["pass", "fail", "pending"];
const isCheckState = (v: unknown): v is CheckState => CHECK_STATES.includes(v);

function savedCheck(v: unknown): SavedCheck[] {
  return isRecord(v) && isName(v.name) && isCheckState(v.state) ? [{ name: v.name, state: v.state }] : [];
}

function savedPr(v: unknown): SavedPr | null {
  if (!isRecord(v) || !isPrUrl(v.url) || !isPrStatus(v.status)) return null;
  const { number, branch } = v;
  if (typeof number !== "number" || !Number.isSafeInteger(number) || number < 1) return null;
  if (typeof branch !== "string" || branch.length === 0 || branch.length > 256) return null;
  const pr: SavedPr = {
    number,
    url: v.url,
    status: v.status,
    branch,
    ...(v.draft === true ? { draft: true } : {}),
    ...(v.mergeable === true ? { mergeable: true } : {}),
  };
  const checks = Array.isArray(v.checks) ? v.checks.flatMap(savedCheck).slice(0, MAX_CHECKS) : [];
  return checks.length ? { ...pr, checks } : pr;
}

const VIEW_MODES: readonly unknown[] = ["all", "projects"];
const isViewMode = (v: unknown): v is ViewMode => VIEW_MODES.includes(v);

// A fold flag per section, bounded like any other map. Empty reads as none,
// so an empty object is a delete rather than a set.
function foldFlags(v: unknown): Record<string, number> | null {
  if (!isRecord(v)) return null;
  const kept = Object.entries(v).flatMap(([id, flag]): [string, number][] =>
    isId(id) && (flag === 0 || flag === 1) ? [[id, flag]] : [],
  );
  return kept.length ? Object.fromEntries(kept.slice(-MAX_ENTRIES)) : null;
}

function uiState(v: unknown): UiState {
  if (!isRecord(v)) return {};
  const collapsed = foldFlags(v.collapsed);
  return { ...(isViewMode(v.mode) ? { mode: v.mode } : {}), ...(collapsed ? { collapsed } : {}) };
}

const UI_KEYS: readonly string[] = ["mode", "collapsed"];

const isLabel = (v: unknown): v is string => isText(v, MAX_LABEL);

const isOptionalId = (v: unknown): boolean => v === undefined || (typeof v === "string" && isId(v));

function savedSubagent(v: unknown): SavedSubagent[] {
  if (!isRecord(v) || !isLabel(v.label) || !isEpoch(v.startedEpoch)) return [];
  const { id, session, agentId, type, endedEpoch } = v;
  if (typeof id !== "string" || !isId(id) || typeof session !== "string" || !isId(session)) return [];
  if (!isOptionalId(agentId) || !isOptionalId(type)) return [];
  if (endedEpoch !== undefined && !isEpoch(endedEpoch)) return [];
  const run: SavedSubagent = { id, session, label: v.label, startedEpoch: v.startedEpoch };
  if (typeof agentId === "string") run.agentId = agentId;
  if (typeof type === "string") run.type = type;
  if (isEpoch(endedEpoch)) run.endedEpoch = endedEpoch;
  return [run];
}

function savedSubagents(v: unknown): SavedSubagent[] | null {
  const runs = Array.isArray(v) ? v.flatMap(savedSubagent).slice(-MAX_SUBAGENTS) : [];
  return runs.length ? runs : null;
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
    prs: cleanMap(v.prs, savedPr),
    subagents: cleanMap(v.subagents, savedSubagents),
    ui: uiState(v.ui),
  };
}

export type SetResult = { ok: true; state: State } | { ok: false; error: string };

// The maps a URL may set. `prs` and `subagents` are left out on purpose (see State).
// `ui` is not keyed by id: its only keys are UI_KEYS.
type MapName = "dismissed" | "projectOverride" | "projects" | "ui";
const MAPS: readonly MapName[] = ["dismissed", "projectOverride", "projects", "ui"];
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
    case "ui":
      return { ...state, ui: uiState(Object.fromEntries(Object.entries(state.ui).filter(([k]) => k !== id))) };
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
    case "ui":
      return uiEntry(state, id, parsed);
  }
}

function uiEntry(state: State, id: string, parsed: unknown): State | string {
  if (id === "mode")
    return isViewMode(parsed) ? { ...state, ui: { ...state.ui, mode: parsed } } : 'ui.mode wants "all" or "projects"';
  const collapsed = foldFlags(parsed);
  return collapsed ? { ...state, ui: { ...state.ui, collapsed } } : "ui.collapsed wants {section: 0 or 1}";
}

// Which ids a map takes: a match path for `projects`, a fixed name for `ui`,
// a workspace id for the rest.
function isKeyFor(map: MapName, id: string): boolean {
  if (map === "projects") return isMatchKey(id);
  if (map === "ui") return UI_KEYS.includes(id);
  return isId(id);
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
  if (!isKeyFor(map, id)) return { ok: false, error: `bad key ${JSON.stringify(key)}` };

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
