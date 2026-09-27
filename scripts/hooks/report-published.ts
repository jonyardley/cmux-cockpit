// Records the pages and docs agents publish (#52), which are otherwise only
// findable in terminal scrollback.
//
// Run as a Claude Code PostToolUse hook (docs/state-loop.md has the
// settings.json block) on the Artifact tool and the Claude Docs batch and
// create tools. Each invocation gets one event as JSON on stdin and the
// workspace id from CMUX_WORKSPACE_ID, and folds the link into
// config/state.json's `published` map (scripts/state-config.ts), keyed by
// URL so a republish updates its entry, under the same file lock every
// other state write takes. Entries older than seven days are dropped on
// every write. It never fails the hook: every problem is a note on stderr
// and exit 0.
//
// What tool_response holds for these tools is not documented, so the URL is
// looked for in every string inside it (a plain string, MCP content blocks
// or an object all work), and the title comes from the tool's own input
// (the page's <title>, the doc's name) rather than from the result's words.

import { readFileSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import { scheduleBuild } from "../hook-build.ts";
import { isPublishedUrl, type PublishedKind, type SavedPublished, type State } from "../state-config.ts";
import { writePublished } from "../state-url.ts";
import { cleanLabel } from "./report-subagent.ts";

type PublishedMap = State["published"];

/** Seven days: older entries drop off (#52). */
export const MAX_AGE_S = 7 * 24 * 60 * 60;

const DOCS_BATCH = "mcp__claude_ai_Claude_Docs__batch";
const DOCS_CREATE = "mcp__claude_ai_Claude_Docs__create";
const ARTIFACT_URL = /https:\/\/claude\.ai\/(?:code\/)?artifact\/[\w-]+/;
// A tool result is small; this bounds a pathological one, not a real one.
const MAX_DEPTH = 8;
// The page is only read for its <title>, which sits near the top.
const MAX_HTML_BYTES = 256 * 1024;

function field(obj: unknown, key: string): unknown {
  return typeof obj === "object" && obj !== null && key in obj ? Reflect.get(obj, key) : undefined;
}

// The first claude.ai artifact link in any string inside `v`, depth first.
function findUrl(v: unknown, depth = 0): string | null {
  if (depth > MAX_DEPTH) return null;
  if (typeof v === "string") return v.match(ARTIFACT_URL)?.[0] ?? null;
  if (typeof v !== "object" || v === null) return null;
  for (const child of Object.values(v)) {
    const found = findUrl(child, depth + 1);
    if (found) return found;
  }
  return null;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", apos: "'" };

/** The text of an HTML page's first <title>, entities decoded, untrimmed; null without one. */
export function titleFromHtml(html: string): string | null {
  const raw = html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1];
  if (raw === undefined) return null;
  return raw.replaceAll(/&(amp|lt|gt|quot|#39|apos);/g, (_, name: string) => ENTITIES[name] ?? "");
}

/** Reads a local file, or null when it cannot. The real one caps the size read. */
export type ReadFile = (path: string) => string | null;

function readHead(path: string): string | null {
  try {
    return readFileSync(path, "utf8").slice(0, MAX_HTML_BYTES);
  } catch {
    return null;
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

/** The first candidate that cleans up to a title, else "Untitled". */
function titleOf(...candidates: unknown[]): string {
  for (const candidate of candidates) {
    const cleaned = cleanLabel(candidate);
    if (cleaned) return cleaned;
  }
  return "Untitled";
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
  const url = isPublishedUrl(asked) ? asked : findUrl(field(event, "tool_response"));
  if (!url) return null;
  return { url, title: titleOf(pageTitle(event, read), field(input, "title"), fileName(event)) };
}

// A batch creates a doc only when its container carries `create`; one with
// an `id` edits an existing doc, which was recorded when it was made.
function docsEntry(event: unknown, tool: string): { url: string; title: string } | null {
  const input = field(event, "tool_input");
  const create = field(field(input, "container"), "create");
  if (tool === DOCS_BATCH && (typeof create !== "object" || create === null)) return null;
  const url = findUrl(field(event, "tool_response"));
  if (!url) return null;
  return { url, title: titleOf(field(create, "name"), field(input, "title"), field(input, "name")) };
}

function kindOf(tool: unknown): PublishedKind | null {
  if (tool === "Artifact") return "page";
  return tool === DOCS_BATCH || tool === DOCS_CREATE ? "doc" : null;
}

/**
 * The entry one PostToolUse event publishes, or null when it publishes
 * nothing this hook records. `read` fetches the published page to find its
 * <title>; it is a parameter so tests need no files.
 */
export function publishedFrom(event: unknown, wsId: string, now: number, read: ReadFile): SavedPublished | null {
  if (field(event, "hook_event_name") !== "PostToolUse") return null;
  const tool = field(event, "tool_name");
  const kind = kindOf(tool);
  if (!kind || typeof tool !== "string") return null;
  const found = kind === "page" ? artifactEntry(event, read) : docsEntry(event, tool);
  return found ? { ...found, kind, workspace: wsId, epoch: now } : null;
}

/**
 * Adds or replaces one entry, moved last as the newest, and drops every
 * entry older than MAX_AGE_S. A null entry only prunes. The input is not
 * changed.
 */
export function applyPublished(map: PublishedMap, entry: SavedPublished | null, now: number): PublishedMap {
  const kept = Object.entries(map).filter(([url, e]) => url !== entry?.url && now - e.epoch <= MAX_AGE_S);
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
  if (!entry) return null;
  if (!wsId) return "skipped, not in a cmux workspace";
  const result = writePublished(STATE_PATH, (published) => applyPublished(published, entry, now));
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
