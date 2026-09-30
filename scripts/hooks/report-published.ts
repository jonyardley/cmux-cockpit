// Records the pages and docs agents publish (#52), which are otherwise only
// findable in terminal scrollback.
//
// Run as a Claude Code PostToolUse hook (docs/state-loop.md has the
// settings.json block) on the Artifact tool and the Claude Docs batch and
// update tools. Docs' `create` tool is left out: it adds a tab, comment or
// upload to an existing doc, never a new doc. Opening an artifact, or
// editing a doc, touches its saved entry: it moves to now and to the
// workspace doing the work, so a doc made days ago and worked on today
// shows as this workspace's. Each invocation gets one event as JSON on stdin and the
// workspace id from CMUX_WORKSPACE_ID, and folds the link into
// config/state.json's `published` map (scripts/state-config.ts), keyed by
// URL so a republish updates its entry, under the same file lock every
// other state write takes. Entries older than seven days are dropped on
// every write. It never fails the hook: every problem is a note on stderr
// and exit 0.
//
// What tool_response holds for these tools is not documented, so the URL is
// looked for in every string inside it (a plain string, MCP content blocks
// or an object all work), skipping any link the call's own input names (a
// type or a source artifact), and the title comes from the tool's own input
// (the page's <title>, the doc's name) rather than from the result's words.
//
// Known gaps: one artifact has two link forms (claude.ai/artifact/<id> and
// claude.ai/code/artifact/<uuid>) with different ids, so a republish under
// the other form is a second entry; and an update that names its url is
// recorded without reading the result, so a refused republish still counts.

import { closeSync, openSync, readFileSync, readSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import { isFresh } from "../../src/shared/published-age.ts";
import { scheduleBuild } from "../hook-build.ts";
import { isPublishedUrl, labelFrom, type PublishedKind, type SavedPublished, type State } from "../state-config.ts";
import { writePublished } from "../state-url.ts";

type PublishedMap = State["published"];

const DOCS_BATCH = "mcp__claude_ai_Claude_Docs__batch";
const DOCS_UPDATE = "mcp__claude_ai_Claude_Docs__update";
const DOC_ID = /^[\w-]{1,200}$/;
const ARTIFACT_URL = /https:\/\/claude\.ai\/(?:code\/)?artifact\/[\w-]+/g;
// A tool result is small; this bounds a pathological one, not a real one.
const MAX_DEPTH = 8;
// The page is only read for its <title>, which sits near the top.
const MAX_HTML_BYTES = 256 * 1024;

function field(obj: unknown, key: string): unknown {
  return typeof obj === "object" && obj !== null && key in obj ? Reflect.get(obj, key) : undefined;
}

// Every claude.ai artifact link in any string inside `v`, depth first.
function linksIn(v: unknown, depth = 0): string[] {
  if (depth > MAX_DEPTH) return [];
  if (typeof v === "string") return v.match(ARTIFACT_URL) ?? [];
  if (typeof v !== "object" || v === null) return [];
  return Object.values(v).flatMap((child) => linksIn(child, depth + 1));
}

// The first link the result names that the call's input does not: a create
// from a type, or a copy from another artifact, names those in its input,
// and the result may echo them beside the new page's own link.
function newLink(event: unknown): string | null {
  const named = new Set(linksIn(field(event, "tool_input")));
  return linksIn(field(event, "tool_response")).find((url) => !named.has(url)) ?? null;
}

const NAMED: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "\u2013",
  mdash: "\u2014",
  hellip: "\u2026",
  lsquo: "\u2018",
  rsquo: "\u2019",
  ldquo: "\u201C",
  rdquo: "\u201D",
};

// A numeric reference's character, or the reference untouched when it names
// no valid code point.
function fromCode(ref: string, code: number): string {
  return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : ref;
}

function decodeEntity(ref: string, body: string): string {
  if (body.startsWith("#x") || body.startsWith("#X")) return fromCode(ref, Number.parseInt(body.slice(2), 16));
  if (body.startsWith("#")) return fromCode(ref, Number.parseInt(body.slice(1), 10));
  return Object.hasOwn(NAMED, body) ? (NAMED[body] ?? ref) : ref;
}

/** The text of an HTML page's first <title>, entities decoded, untrimmed; null without one. */
export function titleFromHtml(html: string): string | null {
  const raw = html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1];
  if (raw === undefined) return null;
  return raw.replaceAll(/&(#[xX][0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, decodeEntity);
}

/** Reads a local file, or null when it cannot. The real one caps the size read. */
export type ReadFile = (path: string) => string | null;

// Reads at most MAX_HTML_BYTES, so a page with megabytes of inlined images
// never slows the publish it follows.
function readHead(path: string): string | null {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const buf = Buffer.alloc(MAX_HTML_BYTES);
    const n = readSync(fd, buf, 0, MAX_HTML_BYTES, 0);
    return buf.subarray(0, n).toString("utf8");
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

// The published page's own <title>, read from the file the agent published.
function pageTitle(event: unknown, read: ReadFile): string | null {
  const file = field(field(event, "tool_input"), "file_path");
  if (typeof file !== "string" || !/\.html?$/i.test(file)) return null;
  const cwd = field(event, "cwd");
  const html = read(typeof cwd === "string" ? resolve(cwd, file) : file);
  return html === null ? null : titleFromHtml(html);
}

function fileName(event: unknown): string | null {
  const file = field(field(event, "tool_input"), "file_path");
  return typeof file === "string" ? basename(file, extname(file)) : null;
}

// Only a publish of the page itself: no other action, and not an upload to
// its asset store.
function isPagePublish(input: unknown): boolean {
  const action = field(input, "action");
  return (action === undefined || action === "publish") && field(input, "asset") !== true;
}

function artifactEntry(event: unknown, read: ReadFile): { url: string; title: string } | null {
  const input = field(event, "tool_input");
  if (!isPagePublish(input)) return null;
  const asked = field(input, "url");
  const url = isPublishedUrl(asked) ? asked : newLink(event);
  if (!url) return null;
  return { url, title: labelFrom("Untitled", pageTitle(event, read), field(input, "title"), fileName(event)) };
}

// A batch creates a doc only when its container carries `create`; one with
// an `id` edits an existing doc, which was recorded when it was made.
function docsEntry(event: unknown): { url: string; title: string } | null {
  const create = field(field(field(event, "tool_input"), "container"), "create");
  if (typeof create !== "object" || create === null) return null;
  const url = newLink(event);
  if (!url) return null;
  return { url, title: labelFrom("Untitled", field(create, "name")) };
}

function kindOf(tool: unknown): PublishedKind | null {
  if (tool === "Artifact") return "page";
  return tool === DOCS_BATCH ? "doc" : null;
}

/**
 * The entry one PostToolUse event publishes, or null when it publishes
 * nothing this hook records. `read` fetches the published page to find its
 * <title>; it is a parameter so tests need no files.
 */
export function publishedFrom(event: unknown, wsId: string, now: number, read: ReadFile): SavedPublished | null {
  if (field(event, "hook_event_name") !== "PostToolUse") return null;
  const kind = kindOf(field(event, "tool_name"));
  if (!kind) return null;
  const found = kind === "page" ? artifactEntry(event, read) : docsEntry(event);
  return found ? { ...found, kind, workspace: wsId, epoch: now } : null;
}

// A doc's id is the <uuid> of its claude.ai/code/artifact/<uuid> link.
function docLink(id: unknown): string | null {
  return typeof id === "string" && DOC_ID.test(id) ? `https://claude.ai/code/artifact/${id}` : null;
}

// The doc an edit names: its container, or a ref to the doc itself (a rename).
function editedDoc(input: unknown): string | null {
  const container = field(input, "container");
  if (field(container, "create") !== undefined) return null;
  const ref = field(input, "ref");
  return docLink(field(container, "id")) ?? (field(ref, "object") === "project" ? docLink(field(ref, "id")) : null);
}

/**
 * The link one PostToolUse event works on without publishing it: an
 * Artifact open, or a Claude Docs edit (update, or a batch on an existing
 * doc). Null for anything else. Only an entry already saved is touched,
 * since these calls carry no title.
 */
export function touchedFrom(event: unknown): string | null {
  if (field(event, "hook_event_name") !== "PostToolUse") return null;
  const tool = field(event, "tool_name");
  const input = field(event, "tool_input");
  if (tool === "Artifact") {
    const url = field(input, "url");
    return field(input, "action") === "open" && isPublishedUrl(url) ? url : null;
  }
  return tool === DOCS_BATCH || tool === DOCS_UPDATE ? editedDoc(input) : null;
}

/**
 * Moves a saved entry to `now` and to workspace `wsId`, last as the newest,
 * pruning as applyPublished does. A link with no saved entry only prunes.
 */
export function applyTouch(map: PublishedMap, url: string, wsId: string, now: number): PublishedMap {
  const saved = map[url];
  return applyPublished(map, saved ? { ...saved, workspace: wsId, epoch: now } : null, now);
}

/**
 * Adds or replaces one entry, moved last as the newest, and drops every
 * entry older than seven days (PUBLISHED_MAX_AGE_S). A null entry only prunes. The input is not
 * changed.
 */
export function applyPublished(map: PublishedMap, entry: SavedPublished | null, now: number): PublishedMap {
  const kept = Object.entries(map).filter(([url, e]) => url !== entry?.url && isFresh(e.epoch, now));
  return Object.fromEntries(entry ? [...kept, [entry.url, entry]] : kept);
}

const STATE_PATH = join(import.meta.dirname, "..", "..", "config", "state.json");

function readEvent(): unknown {
  try {
    return JSON.parse(readFileSync(0, "utf8"));
  } catch {
    return undefined;
  }
}

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

// Records the event, returning a note for stderr when something went wrong.
function record(event: unknown, wsId: string | undefined): string | null {
  const now = Math.floor(Date.now() / 1000);
  const entry = publishedFrom(event, wsId ?? "", now, readHead);
  if (entry) {
    if (!wsId) return "skipped, not in a cmux workspace";
    return write((published) => applyPublished(published, entry, now));
  }
  // A touch outside cmux is nothing worth a note: it would fire on every doc edit.
  const touched = touchedFrom(event);
  if (!touched || !wsId) return null;
  return write((published) => applyTouch(published, touched, wsId, now));
}

// Folds `update` into the saved map, rebuilding when it changed.
function write(update: (published: PublishedMap) => PublishedMap): string | null {
  const result = writePublished(STATE_PATH, update);
  if (!result.ok) return result.error;
  if (result.changed) scheduleBuild("report-published");
  return null;
}

if (import.meta.main) {
  let note: string | null;
  try {
    note = record(readEvent(), process.env.CMUX_WORKSPACE_ID);
  } catch (err) {
    note = errorText(err);
  }
  if (note) console.error(`report-published: ${note}`);
}
