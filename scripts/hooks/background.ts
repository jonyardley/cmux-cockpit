// Whether a Bash call went to the background, from its PostToolUse event.
// Shared by report-shell.ts, which saves the shell, and report-pr.ts, which
// must not poll a gh call that has not finished.
//
// A call reaches the background four ways: started with run_in_background,
// sent there mid-run with Ctrl+B, moved there by Claude Code when it outran
// its timeout, or moved there so Claude Code could deliver a message the
// person sent (backgroundedToDeliverMessage). Only the first sets
// run_in_background, but all four carry backgroundTaskId in the result.

import { field } from "./gh-command.ts";

// Claude Code's words for a call in the background, when the result carries
// no backgroundTaskId: "running in background with ID: x" for one started
// there, "moved to the background (ID: x)" for one moved there.
const ID_IN_TEXT = /(?:running in background with ID: |moved to the background \(ID: )([\w-]+)/;

/** True when the call was started with run_in_background. */
const startedInBackground = (event: unknown): boolean =>
  field(field(event, "tool_input"), "run_in_background") === true;

/**
 * The background task id of a Bash call, or null when it ran in the
 * foreground. The text is only read for a call started in the background:
 * a foreground command's own output could print anything.
 */
export function backgroundTaskId(event: unknown): string | null {
  const response = field(event, "tool_response");
  const id = field(response, "backgroundTaskId");
  if (typeof id === "string" && id) return id;
  if (!startedInBackground(event)) return null;
  const text = field(response, "stdout");
  return typeof text === "string" ? (ID_IN_TEXT.exec(text)?.[1] ?? null) : null;
}

/** True when the call went to the background by any of the four ways, so it may still be running. */
export const wentToBackground = (event: unknown): boolean =>
  startedInBackground(event) || backgroundTaskId(event) !== null;

/**
 * Seconds the call had already run when it went to the background: its
 * timeout for one Claude Code moved there on timeout, else 0, since nothing
 * in the result says how long a Ctrl+B or message move had run.
 */
export function secondsBeforeBackground(event: unknown): number {
  const ms = field(field(event, "tool_response"), "timedOutAfterMs");
  return typeof ms === "number" && ms > 0 ? Math.floor(ms / 1000) : 0;
}
