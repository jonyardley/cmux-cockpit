// Whether a Bash call went to the background, from its PostToolUse event,
// so report-pr.ts never polls a gh call that has not finished.
//
// A call reaches the background four ways: started with run_in_background,
// sent there mid-run with Ctrl+B, moved there by Claude Code when it outran
// its timeout, or moved there so Claude Code could deliver a message the
// person sent (backgroundedToDeliverMessage). Only the first sets
// run_in_background, but all four carry backgroundTaskId in the result.

import { field } from "./gh-command.ts";

/** True when the call went to the background by any of the four ways, so it may still be running. */
export function wentToBackground(event: unknown): boolean {
  if (field(field(event, "tool_input"), "run_in_background") === true) return true;
  const id = field(field(event, "tool_response"), "backgroundTaskId");
  return typeof id === "string" && id !== "";
}
