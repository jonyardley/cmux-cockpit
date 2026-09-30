// Which cockpit hook scripts run for which Claude Code event: the one list,
// read by dispatch.ts at run time and by setup for the entry points it
// writes. Claude Code's settings hold only one entry per event, so adding,
// dropping or re-matching a script here takes effect on the next event,
// with no setup run.

type Obj = Record<string, unknown>;

/** One script for an event, and the matcher that picks it, as Claude Code would read it; none runs it every time. */
export interface Route {
  script: string;
  matcher?: string;
  /** Its block decision on stdout reaches Claude Code (dispatch.ts); every other script's stdout is dropped. */
  sendsBack?: true;
}

export const ROUTES: Readonly<Record<string, readonly Route[]>> = {
  PreToolUse: [
    { script: "report-subagent.ts", matcher: "Agent" },
    { script: "report-notification.ts", matcher: "AskUserQuestion|ExitPlanMode" },
  ],
  PostToolUse: [
    { script: "report-pr.ts", matcher: "Bash" },
    {
      script: "report-published.ts",
      matcher: "Artifact|mcp__claude_ai_Claude_Docs__batch|mcp__claude_ai_Claude_Docs__update",
    },
  ],
  Stop: [{ script: "report-move.ts", sendsBack: true }, { script: "report-rename.ts" }],
  UserPromptSubmit: [{ script: "report-rename.ts" }],
  SessionStart: [{ script: "report-rename.ts" }],
  SubagentStart: [{ script: "report-subagent.ts" }],
  SubagentStop: [{ script: "report-subagent.ts" }],
  PermissionRequest: [{ script: "report-notification.ts" }],
  Notification: [
    { script: "report-notification.ts", matcher: "permission_prompt|elicitation_dialog|elicitation_url_dialog" },
  ],
};

// The event field Claude Code tests a matcher against, per event.
const MATCHED_FIELD: Readonly<Record<string, string>> = {
  PreToolUse: "tool_name",
  PostToolUse: "tool_name",
  PostToolUseFailure: "tool_name",
  PermissionRequest: "tool_name",
  Notification: "notification_type",
  SessionStart: "source",
  SessionEnd: "reason",
  PreCompact: "trigger",
  SubagentStart: "agent_type",
  SubagentStop: "agent_type",
};

/**
 * True when `matcher` picks `value`, as Claude Code's hooks guide describes
 * it: missing, "" and "*" match everything; a plain name, or names joined
 * with |, match those names exactly; anything else is a case-sensitive
 * regex found anywhere in the value. One that is not a valid regex matches
 * nothing.
 */
export function matches(matcher: string | undefined, value: string | undefined): boolean {
  if (matcher === undefined || matcher === "" || matcher === "*") return true;
  if (value === undefined) return false;
  if (/^[\w|]+$/.test(matcher)) return matcher.split("|").includes(value);
  try {
    return new RegExp(matcher).test(value);
  } catch {
    return false;
  }
}

function routesFor(event: string, payload: Obj | null, routes: typeof ROUTES): readonly Route[] {
  const key = MATCHED_FIELD[event];
  const raw = key === undefined || payload === null ? undefined : payload[key];
  const value = typeof raw === "string" ? raw : undefined;
  return (routes[event] ?? []).filter((r) => matches(r.matcher, value));
}

/** The scripts to run for one event, in list order, given the event's JSON (null when it did not parse). */
export const scriptsFor = (event: string, payload: Obj | null, routes = ROUTES): string[] =>
  routesFor(event, payload, routes).map((r) => r.script);

/** Which of those scripts may send the turn back: only Stop's, since a block on any other event would stop a tool or answer a prompt. */
export const sendersFor = (event: string, payload: Obj | null, routes = ROUTES): string[] =>
  event === "Stop" ? routesFor(event, payload, routes).flatMap((r) => (r.sendsBack ? [r.script] : [])) : [];
