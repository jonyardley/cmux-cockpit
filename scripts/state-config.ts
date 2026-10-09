// The local state loop's contract (docs/state-loop.md): the shape of
// config/state.json, how one `set` from the sidebar changes it, and how the
// build reads it back. Shared by the URL handler (which writes) and build.ts
// (which injects __STATE__), and kept apart from both so it can be tested.
//
// Any web page can open a cmux-cockpit:// URL, so every value arriving here is
// untrusted: bad keys and values are refused, bad entries in the file are
// dropped, and nothing here ever throws on input.

import {
  isCleanChar,
  isHex,
  isMatchKey,
  isName,
  isRoot,
  isSymbol,
  isText,
  MAX_PROJECT_KEY,
} from "../src/shared/project-rules.ts";

export interface State {
  /** wsId -> agent id -> start of the needs_input spell that was dismissed (issue #5). */
  dismissed: Record<string, Record<string, number>>;
  /** wsId -> project key chosen by "Move to project" (issue #8). */
  projectOverride: Record<string, string>;
  /**
   * project key -> a project made or edited in the sidebar (issue #9). The
   * key is a sidebar-made project's folder, or a projects.json project's
   * first match; either way the saved entry wins over the file at build.
   */
  projects: Record<string, SavedProject>;
  /**
   * wsId -> the pull request for the workspace's branch, found by
   * scripts/pr-poll.ts because cmux sends custom sidebars none (issue #7).
   * Written only by the poller, never by a URL: a URL could plant a link.
   */
  prs: Record<string, SavedPr>;
  /**
   * url -> one of Jon's own open pull requests in a repo some workspace sits
   * in, found by scripts/pr-poll.ts, so a PR still shows once its workspace
   * is closed. Written only by the poller, never by a URL.
   */
  ownPrs: Record<string, SavedOwnPr>;
  /**
   * wsId -> the workspace's subagent runs, oldest first, recorded by
   * scripts/hooks/report-subagent.ts because cmux sends custom sidebars none
   * (issue #6). Written only by the hook, never by a URL.
   */
  subagents: Record<string, SavedSubagent[]>;
  /**
   * wsId -> the background shells its chats have running, oldest first,
   * recorded by scripts/hooks/report-shell.ts because cmux sends custom
   * sidebars none. A shell is removed once Claude Code reports it done.
   * Written only by the hook, never by a URL. Left out while nothing is
   * saved, so a file from before it existed reads the same.
   */
  shells?: Record<string, SavedShell[]>;
  /**
   * Claude Code session id -> the name its agent row shows, recorded by
   * scripts/hooks/report-rename.ts because cmux's own agent title is the
   * first message, which it cannot read for every Claude folder. Oldest
   * first, so the cap drops the sessions named longest ago. Written only
   * by the hook, never by a URL: a URL could plant words as a chat's name.
   */
  names: Record<string, SavedName>;
  /**
   * url -> a page or doc an agent published, recorded by
   * scripts/hooks/report-published.ts (issue #52), oldest first. Keyed by
   * URL so a republish replaces its entry. Written only by the hook, never
   * by a URL: a URL could plant a link.
   */
  published: Record<string, SavedPublished>;
  /**
   * url -> the chat that opened a pull request, recorded by
   * scripts/hooks/report-pr.ts, oldest first. Written only by the hook,
   * never by a URL: a URL could plant a link.
   */
  prOrigins: Record<string, SavedPrOrigin>;
  /**
   * wsId -> why its agent last stopped to ask (issue #81): a permission
   * prompt, a question or an MCP form, recorded by
   * scripts/hooks/report-notification.ts because cmux says only that an
   * agent needs you, never why. Written through applySet, but refused from
   * a URL (urlMaySet): a URL could plant a question.
   */
  asking: Record<string, SavedAsk>;
  /**
   * wsId -> the "Your move" line its chat last ended a turn on, recorded by
   * scripts/hooks/report-move.ts, since cmux keeps only the start of a
   * message and the line is always at its end. Hook-only, like `asking`:
   * a URL could plant words the card shows as the chat's own.
   */
  moves: Record<string, SavedMove>;
  /**
   * lane id -> the name the cockpit last saw it under in config/lanes.json,
   * so a rename there can rename the lane's cmux group (issue #294). Left
   * out while nothing is saved, so a file from before it existed reads the
   * same.
   */
  laneNames?: Record<string, string>;
  /** The cockpit's view and what is folded, so a rebuild's reload keeps them. */
  ui: UiState;
  /**
   * How the PR poller's last runs went (issue #78), so the sidebars can say
   * when PR data is old or gh is down. Written only by scripts/pr-poll.ts,
   * never by a URL. Left out while nothing is saved, so a file from before
   * it existed reads the same.
   */
  poll?: SavedPoll;
}

/** Why a poll could not reach gh: it failed, it is signed out, or it is not installed. */
export type PollError = "unavailable" | "signed-out" | "missing";

/** The PR poller's last success and its current error, as it saves them. */
export interface SavedPoll {
  /** Epoch seconds of the last run whose gh lookups answered. */
  okEpoch?: number;
  /** Why the latest run could not reach gh; absent once a run gets through. */
  error?: PollError;
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

/** A project made or edited in the sidebar. Its first match is the key it is stored under. */
export interface ProjectSpec {
  name: string;
  color: string;
  icon: string;
  root?: string;
}

/** A projects.json project removed in the sidebar: deleting the entry would bring the file's back. */
export interface ProjectRemoved {
  removed: true;
}

export type SavedProject = ProjectSpec | ProjectRemoved;

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
  /** Set only while GitHub says the PR has merge conflicts (mergeStateStatus "DIRTY"). */
  conflicts?: true;
  /** Its title (pr-poll.ts's cleanTitle), so a card can say what the PR does; left out when it has none. */
  title?: string;
  /** Lines added and removed across its diff; left out when gh sent no count. */
  additions?: number;
  deletions?: number;
  /** Its CI checks, failing first (pr-poll.ts's checksFrom); left out when it has none. */
  checks?: SavedCheck[];
}

/**
 * One of Jon's own open PRs. Only what the Pull requests list shows is
 * kept (no checks or merge verdict), so CI on a PR no workspace holds never
 * rewrites the file or rebuilds the sidebars.
 */
export interface SavedOwnPr {
  number: number;
  url: string;
  status: "open";
  branch: string;
  draft?: true;
  /** Its title, since no workspace names it. */
  title: string;
  /** The repo it was found in (git's common dir), so a failed lookup keeps only that repo's entries. */
  repo: string;
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
  /** Epoch seconds the Agent tool was called, or the latest resume
   * restarted it (report-subagent.ts's onResume). */
  startedEpoch: number;
  /** Epoch seconds the run stopped; absent while it runs. */
  endedEpoch?: number;
}

/** A background shell a chat started, as report-shell.ts saves it. */
export interface SavedShell {
  /** Claude Code's task id for it, which its task-notification names. */
  id: string;
  /** The Claude Code session that started it. */
  session: string;
  /** Epoch seconds it started. */
  startedEpoch: number;
}

/** Where a session's name came from: a `/rename`, or its first real prompt. */
export type NameSource = "title" | "prompt";

/** A session's name, as the hook saves it. */
export interface SavedName {
  /** At most MAX_LABEL characters, cleaned as cleanLabel does. */
  name: string;
  from: NameSource;
}

/** What an agent published: a claude.ai page (Artifact) or doc (Claude Docs). */
export type PublishedKind = "page" | "doc";

/** A page or doc an agent published, as the hook saves it. */
export interface SavedPublished {
  /** Its claude.ai artifact link, the map key too. */
  url: string;
  /** Its title, at most MAX_LABEL characters. */
  title: string;
  kind: PublishedKind;
  /** The cmux workspace the agent ran in (CMUX_WORKSPACE_ID) when it last
   * published it, or edited it (a doc). */
  workspace: string;
  /** Epoch seconds it was last published, or edited (a doc). */
  epoch: number;
}

/** Which chat opened a PR, as the PR hook saves it. */
export interface SavedPrOrigin {
  /** Its GitHub link, the map key too. */
  url: string;
  number: number;
  /** The cmux workspace the agent ran in (CMUX_WORKSPACE_ID). */
  workspace: string;
  /** The terminal it ran in (CMUX_SURFACE_ID), for focusing it; absent when cmux gave none. */
  surface?: string;
  /** The Claude Code session that opened it. */
  session: string;
  /** Epoch seconds it was opened. */
  epoch: number;
}

/** Why an agent stopped to ask, as the notification hook saves it. */
export interface SavedAsk {
  /** A short reason, e.g. "allow git push?", at most MAX_LABEL characters. */
  reason: string;
  /** Epoch seconds the hook heard the ask. */
  epoch: number;
  /** The Claude Code session that asked, so a later event can tell it is the same ask. */
  session?: string;
}

/** What a chat last asked of Jon, as the Stop hook saves it. */
export interface SavedMove {
  /** The line after "Your move:", at most MAX_MOVE characters. */
  text: string;
  /** Epoch seconds the hook saw the turn end. */
  epoch: number;
  /** The Claude Code session whose turn it was. */
  session?: string;
  /** How many numbered decisions the reply laid out, when it laid any out. */
  decisions?: number;
  /** The reply's recommended answers in Jon's shorthand ("1b 2a"), when it marked any. */
  leans?: string;
  /** Set when the line was "Nothing for you:", not "Your move:": the turn waits on the agent. */
  idle?: true;
}

/** The longest "Your move" line kept; the hook cuts one to this. */
export const MAX_MOVE = 200;
/** The most decisions one reply is counted as laying out. */
export const MAX_DECISIONS = 9;

/** Shells kept per workspace, newest kept, so a runaway loop cannot bloat the file. */
export const MAX_SHELLS = 10;

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
  ownPrs: {},
  subagents: {},
  names: {},
  published: {},
  prOrigins: {},
  asking: {},
  moves: {},
  ui: {},
});

// renderer.d.ts puts no shape on workspace or agent ids, and a project key is
// its first match path ("/dev/app"), so only length is bounded. Object
// prototype names are refused, so no entry can land on a prototype.
// Numeric-looking ids would sort first in Object.entries and so be evicted
// first; cmux ids are UUIDs, so that is accepted rather than worked round.
const RESERVED = new Set(["__proto__", "constructor", "prototype"]);
export const isId = (v: string): boolean => v.length > 0 && v.length <= 128 && !RESERVED.has(v);
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

// Keeps whole code points (so a surrogate pair is never split in two) while
// the UTF-16 length, the one isLabel measures, stays within `max`.
function cutTo(text: string, max: number): string {
  let out = "";
  for (const c of text) {
    if (out.length + c.length > max) break;
    out += c;
  }
  return out;
}

// cleanLabel's rule at any length.
function cleanText(raw: unknown, max: number): string | null {
  if (typeof raw !== "string") return null;
  const spaced = [...raw].map((c) => (isCleanChar(c) ? c : " ")).join("");
  const cleaned = cutTo(spaced.replaceAll(/\s+/g, " "), max).trim();
  return cleaned.length ? cleaned : null;
}

/**
 * cleanLabel for a "Your move" line: the same rule, but a line over
 * MAX_MOVE is cut to leave room for an ellipsis and ends in one, so the
 * card shows it was cut. Both lengths are the UTF-16 one isText measures.
 */
export function cleanMove(raw: unknown): string | null {
  const whole = cleanText(raw, Number.POSITIVE_INFINITY);
  if (whole === null || whole.length <= MAX_MOVE) return whole;
  return `${cutTo(whole, MAX_MOVE - 1).trimEnd()}…`;
}

/**
 * Turns hook input into a label isLabel accepts: control characters and
 * whitespace runs become one space, it is cut to MAX_LABEL, and only then
 * trimmed, since trimming first and cutting after can leave a trailing
 * space that isLabel refuses and validateState drops the entry over. Null
 * for anything unusable. Shared by the subagent and published hooks.
 */
export function cleanLabel(raw: unknown): string | null {
  return cleanText(raw, MAX_LABEL);
}

/** The first candidate that cleans up to a label, else `fallback`. */
export function labelFrom(fallback: string, ...candidates: unknown[]): string {
  for (const candidate of candidates) {
    const cleaned = cleanLabel(candidate);
    if (cleaned) return cleaned;
  }
  return fallback;
}

// Exactly {"removed": true}, so a spec with a stray flag is not read as a removal.
const isRemovedEntry = (v: unknown): boolean => isRecord(v) && v.removed === true && Object.keys(v).length === 1;

function savedProject(v: unknown): SavedProject | null {
  return isRemovedEntry(v) ? { removed: true } : projectSpec(v);
}

function projectSpec(v: unknown): ProjectSpec | null {
  if (!isRecord(v) || !isName(v.name) || !isHex(v.color) || !isSymbol(v.icon)) return null;
  const spec: ProjectSpec = { name: v.name, color: v.color, icon: v.icon };
  if (v.root === undefined) return spec;
  return isRoot(v.root) ? { ...spec, root: v.root } : null;
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

const isLabel = (v: unknown): v is string => isText(v, MAX_LABEL);
/** A diff's line count: a whole number, never negative. */
export const isLineCount = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;

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
    ...(v.conflicts === true ? { conflicts: true } : {}),
    ...(isLabel(v.title) ? { title: v.title } : {}),
    ...(isLineCount(v.additions) ? { additions: v.additions } : {}),
    ...(isLineCount(v.deletions) ? { deletions: v.deletions } : {}),
  };
  const checks = Array.isArray(v.checks) ? v.checks.flatMap(savedCheck).slice(0, MAX_CHECKS) : [];
  return checks.length ? { ...pr, checks } : pr;
}

const VIEW_MODES: readonly unknown[] = ["all", "projects"];
const isViewMode = (v: unknown): v is ViewMode => VIEW_MODES.includes(v);

// A fold key is "lane:<key>" or "project:<key>", and a project key can be a
// match path as long as MAX_PROJECT_KEY, so it gets that bound plus room for
// the prefix rather than isId's.
const isFoldKey = (v: string): boolean => v.length > 0 && v.length <= MAX_PROJECT_KEY + 16 && !RESERVED.has(v);

// A fold flag per section, bounded like any other map. Empty reads as none,
// so an empty object is a delete rather than a set.
function foldFlags(v: unknown): Record<string, number> | null {
  if (!isRecord(v)) return null;
  const kept = Object.entries(v).flatMap(([id, flag]): [string, number][] =>
    isFoldKey(id) && (flag === 0 || flag === 1) ? [[id, flag]] : [],
  );
  return kept.length ? Object.fromEntries(kept.slice(-MAX_ENTRIES)) : null;
}

function uiState(v: unknown): UiState {
  if (!isRecord(v)) return {};
  const collapsed = foldFlags(v.collapsed);
  return { ...(isViewMode(v.mode) ? { mode: v.mode } : {}), ...(collapsed ? { collapsed } : {}) };
}

const UI_KEYS: readonly string[] = ["mode", "collapsed"];

/** The longest lane name kept: cmux shows a group's name on one line. */
const MAX_LANE_NAME = 128;
const laneName = (v: unknown): string | null => (isText(v, MAX_LANE_NAME) ? v : null);

const POLL_ERRORS: readonly unknown[] = ["unavailable", "signed-out", "missing"];
const isPollError = (v: unknown): v is PollError => POLL_ERRORS.includes(v);

// Each field stands alone: a bad one is dropped, the other kept. Null when
// nothing usable is left, so the key is left out.
function savedPoll(v: unknown): SavedPoll | null {
  if (!isRecord(v)) return null;
  const poll: SavedPoll = {};
  if (isEpoch(v.okEpoch)) poll.okEpoch = v.okEpoch;
  if (isPollError(v.error)) poll.error = v.error;
  return Object.keys(poll).length ? poll : null;
}

const isRepoDir = (v: unknown): v is string =>
  typeof v === "string" && v.startsWith("/") && v.length <= MAX_PROJECT_KEY;

function savedOwnPr(v: unknown): SavedOwnPr | null {
  const pr = savedPr(v);
  if (pr?.status !== "open" || !isRecord(v) || !isLabel(v.title) || !isRepoDir(v.repo)) return null;
  const own: SavedOwnPr = {
    number: pr.number,
    url: pr.url,
    status: "open",
    branch: pr.branch,
    title: v.title,
    repo: v.repo,
  };
  if (pr.draft) own.draft = true;
  return own;
}

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

/**
 * Only a claude.ai artifact link, the form both an Artifact publish and a
 * Claude Docs doc get, since the sidebar will open it on a tap.
 */
export const isPublishedUrl = (v: unknown): v is string =>
  typeof v === "string" && v.length <= 512 && /^https:\/\/claude\.ai\/(?:code\/)?artifact\/[\w-]+$/.test(v);
const KINDS: readonly unknown[] = ["page", "doc"];
const isKind = (v: unknown): v is PublishedKind => KINDS.includes(v);

function savedPublished(v: unknown): SavedPublished | null {
  if (!isRecord(v) || !isPublishedUrl(v.url) || !isLabel(v.title) || !isKind(v.kind) || !isEpoch(v.epoch)) return null;
  const { workspace } = v;
  if (typeof workspace !== "string" || !isId(workspace)) return null;
  return { url: v.url, title: v.title, kind: v.kind, workspace, epoch: v.epoch };
}

const isPrNumber = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 1;
const isIdText = (v: unknown): v is string => typeof v === "string" && isId(v);

// The number a PR link ends in, so a saved number can be held to its link.
const prNumberOf = (url: string): number => Number(/\/pull\/(\d+)$/.exec(url)?.[1]);

// A field it no longer keeps (the old `mention`) is dropped on the next write.
function savedPrOrigin(v: unknown): SavedPrOrigin | null {
  if (!isRecord(v) || !isPrUrl(v.url) || !isPrNumber(v.number) || !isEpoch(v.epoch)) return null;
  if (prNumberOf(v.url) !== v.number) return null;
  const { workspace, surface, session } = v;
  if (!isIdText(workspace) || !isIdText(session) || !isOptionalId(surface)) return null;
  const origin: SavedPrOrigin = { url: v.url, number: v.number, workspace, session, epoch: v.epoch };
  if (typeof surface === "string") origin.surface = surface;
  return origin;
}

// An origin kept only under its own link: the map key is what the rows look it up by.
const originAt = (v: unknown, url: string): SavedPrOrigin | null => {
  const o = savedPrOrigin(v);
  return o?.url === url ? o : null;
};

function savedAsk(v: unknown): SavedAsk | null {
  if (!isRecord(v) || !isLabel(v.reason) || !isEpoch(v.epoch)) return null;
  const { session } = v;
  if (session !== undefined && (typeof session !== "string" || !isId(session))) return null;
  return { reason: v.reason, epoch: v.epoch, ...(typeof session === "string" ? { session } : {}) };
}

// Jon's shorthand for answers: a decision number and a letter, space apart.
const isLeans = (v: unknown): v is string =>
  typeof v === "string" && v.length <= 40 && /^[1-9][a-z](?: [1-9][a-z])*$/.test(v);
const isDecisions = (v: unknown): v is number =>
  typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= MAX_DECISIONS;

function savedMove(v: unknown): SavedMove | null {
  if (!isRecord(v) || !isText(v.text, MAX_MOVE) || !isEpoch(v.epoch)) return null;
  const { session, decisions, leans, idle } = v;
  if (session !== undefined && (typeof session !== "string" || !isId(session))) return null;
  if (decisions !== undefined && !isDecisions(decisions)) return null;
  if (leans !== undefined && !isLeans(leans)) return null;
  if (idle !== undefined && idle !== true) return null;
  return {
    text: v.text,
    epoch: v.epoch,
    ...(typeof session === "string" ? { session } : {}),
    ...(isDecisions(decisions) ? { decisions } : {}),
    ...(isLeans(leans) ? { leans } : {}),
    ...(idle === true ? { idle } : {}),
  };
}

// A move rides to the cockpit in its workspace's cmux description, which the
// sidebar reads live, so a turn end redraws nothing (docs/state-loop.md,
// "What the chat wants"). The line comes first, so cmux's own list shows it;
// the rest of the move follows in one bracketed JSON tail.
const MOVE_TAIL = /^(.*) ⟦move (\{.*\})⟧$/s;

/** A move as the workspace description the Stop hook sets. */
export function moveDescription(m: SavedMove): string {
  const { text, ...rest } = m;
  return text + " ⟦move " + JSON.stringify(rest) + "⟧";
}

/** The move a workspace description carries, or null when it carries none or a bad one. */
export function moveOfDescription(d: string | undefined): SavedMove | null {
  const found = d === undefined ? null : MOVE_TAIL.exec(d);
  if (!found) return null;
  let rest: unknown;
  try {
    rest = JSON.parse(found[2] ?? "");
  } catch {
    return null;
  }
  return isRecord(rest) ? savedMove({ ...rest, text: found[1] }) : null;
}

/** True when a description is a move's, so it is never shown as Jon's own words. */
export const isMoveDescription = (d: string | undefined): boolean => d !== undefined && MOVE_TAIL.test(d);

const SOURCES: readonly unknown[] = ["title", "prompt"];
const isSource = (v: unknown): v is NameSource => SOURCES.includes(v);

function savedName(v: unknown): SavedName | null {
  return isRecord(v) && isLabel(v.name) && isSource(v.from) ? { name: v.name, from: v.from } : null;
}

function savedShell(v: unknown): SavedShell[] {
  if (!isRecord(v) || !isIdText(v.id) || !isIdText(v.session) || !isEpoch(v.startedEpoch)) return [];
  return [{ id: v.id, session: v.session, startedEpoch: v.startedEpoch }];
}

function savedShells(v: unknown): SavedShell[] | null {
  const shells = Array.isArray(v) ? v.flatMap(savedShell).slice(-MAX_SHELLS) : [];
  return shells.length ? shells : null;
}

function savedSubagents(v: unknown): SavedSubagent[] | null {
  const runs = Array.isArray(v) ? v.flatMap(savedSubagent).slice(-MAX_SUBAGENTS) : [];
  return runs.length ? runs : null;
}

// Keeps the last MAX_ENTRIES valid entries, in insertion order. `clean` is
// handed the key too, for a map whose value must agree with it.
function cleanMap<T>(v: unknown, clean: (value: unknown, id: string) => T | null, validId = isId): Record<string, T> {
  if (!isRecord(v)) return {};
  const kept = Object.entries(v).flatMap(([id, value]): [string, T][] => {
    const c = validId(id) ? clean(value, id) : null;
    return c === null ? [] : [[id, c]];
  });
  return Object.fromEntries(kept.slice(-MAX_ENTRIES));
}

/** Reads whatever is in the file into a State, dropping anything malformed. */
export function validateState(raw: unknown): State {
  const v = isRecord(raw) ? raw : {};
  const poll = savedPoll(v.poll);
  const shells = cleanMap(v.shells, savedShells);
  const laneNames = cleanMap(v.laneNames, laneName);
  return {
    dismissed: cleanMap(v.dismissed, agentStarts),
    projectOverride: cleanMap(v.projectOverride, projectKey),
    projects: cleanMap(v.projects, savedProject, isMatchKey),
    prs: cleanMap(v.prs, savedPr),
    ownPrs: cleanMap(v.ownPrs, savedOwnPr, isPrUrl),
    subagents: cleanMap(v.subagents, savedSubagents),
    names: cleanMap(v.names, savedName),
    published: cleanMap(v.published, savedPublished, isPublishedUrl),
    prOrigins: cleanMap(v.prOrigins, originAt, isPrUrl),
    asking: cleanMap(v.asking, savedAsk),
    moves: cleanMap(v.moves, savedMove),
    ui: uiState(v.ui),
    ...(Object.keys(shells).length ? { shells } : {}),
    ...(Object.keys(laneNames).length ? { laneNames } : {}),
    ...(poll ? { poll } : {}),
  };
}

export type SetResult = { ok: true; state: State } | { ok: false; error: string };

// The maps applySet takes. `prs`, `ownPrs`, `subagents`, `names`, `published`, `prOrigins` and `poll` are left out on purpose (see State).
// `ui` is not keyed by id: its only keys are UI_KEYS. `asking` and `moves` are
// set only by their hooks: the URL handler refuses them (urlMaySet).
type MapName = "dismissed" | "projectOverride" | "projects" | "ui" | "asking" | "moves" | "laneNames";
const MAPS: readonly MapName[] = ["dismissed", "projectOverride", "projects", "ui", "asking", "moves", "laneNames"];
const isMapName = (v: string): v is MapName => (MAPS as readonly string[]).includes(v);

// Maps applySet takes from a hook but never from a URL.
const HOOK_ONLY: readonly string[] = ["asking", "moves"];

/**
 * Whether a cmux-cockpit:// URL may make this set (scripts/state-set.ts
 * checks it first). Any web page can open one, and an `asking` entry is
 * text the sidebars show as the agent's own question.
 */
export const urlMaySet = (key: string): boolean => !HOOK_ONLY.includes(key.split(".", 1)[0] ?? "");

/** An ask older than this beside a newer one is dropped, so closed workspaces do not linger. */
export const ASK_MAX_AGE_S = 24 * 60 * 60;

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
    case "asking":
      return { ...state, asking: without(state.asking, id) };
    case "moves":
      return { ...state, moves: without(state.moves, id) };
    case "laneNames": {
      const { laneNames, ...rest } = state;
      const left = without(laneNames ?? {}, id);
      return Object.keys(left).length ? { ...rest, laneNames: left } : rest;
    }
    case "ui": {
      const { mode, collapsed } = state.ui;
      return { ...state, ui: id === "mode" ? (collapsed ? { collapsed } : {}) : mode ? { mode } : {} };
    }
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
      const spec = savedProject(parsed);
      return spec
        ? { ...state, projects: { ...state.projects, [id]: spec } }
        : "projects wants {name, color: #rrggbb, icon: SF Symbol, root?} or {removed: true}";
    }
    case "ui":
      return uiEntry(state, id, parsed);
    case "asking":
      return askEntry(state, id, parsed);
    case "moves":
      return moveEntry(state, id, parsed);
    case "laneNames": {
      const name = laneName(parsed);
      return name ? { ...state, laneNames: { ...state.laneNames, [id]: name } } : "laneNames wants a lane name string";
    }
  }
}

// Adds the ask last, as the newest, and drops every other ask a day older
// than it, since nothing else ever clears one for a closed workspace.
function askEntry(state: State, id: string, parsed: unknown): State | string {
  const ask = savedAsk(parsed);
  if (!ask) return "asking wants {reason, epoch, session?}";
  const kept = Object.entries(state.asking).filter(([, a]) => a.epoch >= ask.epoch - ASK_MAX_AGE_S);
  return { ...state, asking: { ...Object.fromEntries(kept), [id]: ask } };
}

/**
 * Another workspace's move older than this, next to a new one, is dropped: a
 * week, not ASK_MAX_AGE_S's day, since a chat can wait on Jon over a weekend.
 * MAX_ENTRIES still caps the map.
 */
export const MOVE_MAX_AGE_S = 7 * 24 * 60 * 60;

// As askEntry: the move goes last, and moves a week older than it are dropped.
function moveEntry(state: State, id: string, parsed: unknown): State | string {
  const move = savedMove(parsed);
  if (!move) return "moves wants {text, epoch, session?, decisions?, leans?, idle?: true}";
  const kept = Object.entries(state.moves).filter(([, m]) => m.epoch >= move.epoch - MOVE_MAX_AGE_S);
  return { ...state, moves: { ...Object.fromEntries(kept), [id]: move } };
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
 * Whether a set needs a rebuild to show. The sidebar already shows its own
 * view and folds, and every rebuild bakes in the file as it stands, so a
 * `ui` set only has to be written: rebuilding on each tap would reload the
 * sidebar under the tap. A `laneNames` set is the sidebar's own record of
 * what it already acted on, so it needs no rebuild either.
 */
const WRITE_ONLY: readonly string[] = ["ui", "laneNames"];
export const rebuildsOn = (key: string): boolean => !WRITE_ONLY.some((map) => key.startsWith(`${map}.`));

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
