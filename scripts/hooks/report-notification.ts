// Records why an agent stopped to ask (#81). cmux marks an agent needs_input
// both when it asks (a permission prompt, a question, an MCP form) and when
// it simply finished its turn, and says nothing about which, so the sidebars
// could only show one clay "Needs you" for both. Claude Code's hooks do say:
// this hook saves a short reason ("allow git push?") per workspace in
// config/state.json's `asking` map (scripts/state-config.ts), and the
// sidebars turn a needs_input that began with a fresh ask amber, "Asking"
// (src/shared/needs.ts's askReason). An ask older than the agent's current
// needs_input spell is ignored there, so nothing here has to clear it.
//
// Run as a Claude Code hook on three events (docs/state-loop.md has the
// settings.json block):
//   - PermissionRequest (every tool): fires the moment Claude Code is about
//     to ask, the same moment cmux's own PermissionRequest hook marks the
//     agent needs_input, and carries the tool and its input, so the reason
//     can name the command or file.
//   - Notification (permission_prompt, elicitation_dialog,
//     elicitation_url_dialog, agent_needs_input): the asks with no
//     PermissionRequest (an MCP form, a sandboxed network request), and a
//     re-stamp of one still waiting. A permission_prompt from the session
//     that saved the last ask keeps that ask's richer reason.
//   - PreToolUse (AskUserQuestion, ExitPlanMode): under bypassPermissions
//     these two fire no PermissionRequest, and cmux flags them needs_input
//     from PreToolUse instead.
// idle_prompt is not an ask: it is the turn-end nudge, "Your turn".
//
// Each invocation gets one event as JSON on stdin and the workspace id from
// CMUX_WORKSPACE_ID. The write goes through state-url.ts's readApplyWrite,
// the same locked read-modify-write a URL's set takes (the URL handler
// refuses this map), then schedules the shared coalesced rebuild
// (scripts/hook-build.ts). It never fails the hook and never prints to
// stdout, so it can never answer a permission prompt: every problem is a
// note on stderr and exit 0.

import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { scheduleBuild } from "../hook-build.ts";
import { cleanLabel, isId, labelFrom, type SavedAsk, validateState } from "../state-config.ts";
import { readApplyWrite } from "../state-url.ts";

function field(obj: unknown, key: string): unknown {
  return typeof obj === "object" && obj !== null && key in obj ? Reflect.get(obj, key) : undefined;
}

const text = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

// Tools that change a file, and the verb the reason uses for each.
const FILE_VERBS: Readonly<Record<string, string>> = {
  Edit: "edit",
  MultiEdit: "edit",
  Write: "write",
  NotebookEdit: "edit",
};
const SEGMENTS = /&&|\|\||[;|\n]/;
// Words that only wrap the command that matters.
const PREFIXES = new Set(["rtk", "sudo", "env", "command", "exec", "time", "nohup"]);

/**
 * The first two words of the part of a shell command worth naming: the
 * first segment that is not a `cd`, past any env assignments and wrapper
 * words (`rtk gh pr merge` names "gh pr"). Null when nothing is left.
 */
export function commandWords(command: string): string | null {
  for (const segment of command.split(SEGMENTS)) {
    const words = segment.trim().split(/\s+/).filter(Boolean);
    let start = 0;
    for (const w of words) {
      if (!/^\w+=/.test(w) && !PREFIXES.has(w)) break;
      start++;
    }
    const rest = words.slice(start);
    if (rest.length && rest[0] !== "cd") return rest.slice(0, 2).join(" ");
  }
  return null;
}

function hostOf(url: unknown): string | null {
  const raw = text(url);
  if (!raw) return null;
  try {
    return new URL(raw).host || null;
  } catch {
    return null;
  }
}

// An MCP tool's own name, past its server: mcp__claude_ai_Slack__slack_send_message.
const mcpTool = (tool: string): string | null => (tool.startsWith("mcp__") ? (tool.split("__").at(-1) ?? null) : null);

function fileReason(verb: string, input: unknown): string {
  const path = text(field(input, "file_path")) ?? text(field(input, "notebook_path"));
  return path ? `allow ${verb} ${basename(path)}?` : `allow ${verb}?`;
}

function toolReason(tool: string, input: unknown): string {
  if (tool === "Bash") {
    const words = commandWords(text(field(input, "command")) ?? "");
    return words ? `allow ${words}?` : "allow a command?";
  }
  const verb = FILE_VERBS[tool];
  if (verb) return fileReason(verb, input);
  if (tool === "WebFetch") {
    const host = hostOf(field(input, "url"));
    return host ? `allow fetch ${host}?` : "allow a fetch?";
  }
  return `allow ${mcpTool(tool) ?? tool}?`;
}

/** The reason for a tool call Claude Code is asking about, from its name and input. */
export function permissionReason(event: unknown): string {
  const tool = text(field(event, "tool_name")) ?? "";
  const input = field(event, "tool_input");
  if (tool === "AskUserQuestion") {
    const questions = field(input, "questions");
    const first: unknown = Array.isArray(questions) ? questions[0] : undefined;
    return labelFrom("a question", field(first, "question"));
  }
  if (tool === "ExitPlanMode") return "approve the plan?";
  return labelFrom("allow a tool?", tool ? toolReason(tool, input) : null);
}

// What each kind of ask says when its message is empty.
const NOTIFY_FALLBACK: Readonly<Record<string, string>> = {
  permission_prompt: "needs permission",
  elicitation_dialog: "a form to fill in",
  elicitation_url_dialog: "a link to open",
  agent_needs_input: "needs your input",
};

const PERMISSION_TO_USE = /permission to use (.+?)\.?$/i;

/** The reason a Notification gives: "Claude needs your permission to use Bash" reads "allow Bash?". */
export function notificationReason(event: unknown, type: string): string {
  const message = cleanLabel(field(event, "message"));
  const tool = message?.match(PERMISSION_TO_USE)?.[1];
  return labelFrom(
    NOTIFY_FALLBACK[type] ?? "needs you",
    tool ? `allow ${tool}?` : null,
    message,
    field(event, "title"),
  );
}

/** How long a saved ask's reason is reused by a permission_prompt from the same session. */
export const REUSE_S = 120;

// Claude Code's session ids are UUIDs; anything else is left out rather than saved.
const SESSION_ID = /^[\w-]{1,128}$/;

const ASK_TOOLS = new Set(["AskUserQuestion", "ExitPlanMode"]);

// The reason one event gives, or null when it is not an ask.
function reasonFor(
  event: unknown,
  session: string | undefined,
  now: number,
  saved: SavedAsk | undefined,
): string | null {
  const hook = field(event, "hook_event_name");
  if (hook === "PermissionRequest") return permissionReason(event);
  if (hook === "PreToolUse") return ASK_TOOLS.has(String(field(event, "tool_name"))) ? permissionReason(event) : null;
  if (hook !== "Notification") return null;
  const type = text(field(event, "notification_type"));
  if (!type || !Object.hasOwn(NOTIFY_FALLBACK, type)) return null;
  // Claude Code's permission_prompt follows the PermissionRequest for the
  // same prompt about six seconds later, with only the tool's name to say.
  const same = session !== undefined && saved?.session === session && now - saved.epoch <= REUSE_S;
  if (type === "permission_prompt" && same && saved) return saved.reason;
  return notificationReason(event, type);
}

/**
 * The ask one hook event records, or null when it records none. `saved` is
 * the workspace's ask as the file holds it, so a permission_prompt can keep
 * the reason its PermissionRequest saved.
 */
export function askFrom(event: unknown, now: number, saved?: SavedAsk): SavedAsk | null {
  const raw = field(event, "session_id");
  const session = typeof raw === "string" && SESSION_ID.test(raw) && isId(raw) ? raw : undefined;
  const reason = reasonFor(event, session, now, saved);
  if (reason === null) return null;
  return { reason, epoch: now, ...(session ? { session } : {}) };
}

const STATE_PATH = join(import.meta.dirname, "..", "..", "config", "state.json");

// The workspace's saved ask, read without the lock: it only picks a reason,
// and a write racing it at worst costs the richer one.
function savedAsk(wsId: string): SavedAsk | undefined {
  try {
    const asking = validateState(JSON.parse(readFileSync(STATE_PATH, "utf8"))).asking;
    return Object.hasOwn(asking, wsId) ? asking[wsId] : undefined;
  } catch {
    return undefined;
  }
}

function readEvent(): unknown {
  try {
    return JSON.parse(readFileSync(0, "utf8"));
  } catch {
    return undefined;
  }
}

// Records the event, returning a note for stderr when something went wrong.
function record(event: unknown, wsId: string | undefined): string | null {
  if (!wsId) return null;
  const ask = askFrom(event, Math.floor(Date.now() / 1000), savedAsk(wsId));
  if (!ask) return null;
  const result = readApplyWrite(STATE_PATH, `asking.${wsId}`, JSON.stringify(ask));
  if (!result.ok) return result.error;
  if (result.changed) scheduleBuild("report-notification");
  return null;
}

if (import.meta.main) {
  let note: string | null;
  try {
    note = record(readEvent(), process.env.CMUX_WORKSPACE_ID);
  } catch (err) {
    note = err instanceof Error ? err.message : String(err);
  }
  if (note) console.error(`report-notification: ${note}`);
}
