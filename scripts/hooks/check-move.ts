// Sends a turn back when its final reply has no line the sidebar can read.
// A turn end with no "Your move" or "Nothing for you" line reads as Jon's
// turn once the idle nudge lands, so a chat that is really waiting on its
// own background work (CI, a monitor) pings him for nothing. Rather than
// guess at every wording, the chat is asked to add the line.
//
// Run by scripts/hooks/dispatch.ts on Stop. It prints Claude Code's block
// decision on stdout, which dispatch passes on for this script alone. Only
// inside a cmux workspace, since only the sidebar reads the line, and never
// twice in a row: a turn already sent back (stop_hook_active) ends as it is.
// It never fails the hook: every problem is a note on stderr and exit 0.

import { readFileSync } from "node:fs";
import { field } from "./gh-command.ts";
import { finalReply, moveLine } from "./report-move.ts";

/** What the chat is told when its turn is sent back. */
export const SEND_BACK_REASON =
  "Your reply has no closing line the cmux sidebar can read. Reply with only that line: " +
  '"Your move: <what Jon does next>" when something waits on him, or ' +
  '"Nothing for you: <what is running and what he hears next>" when the turn waits on your own work.';

/** The reason to send the turn back, or null to let it end. `reply` is the turn's final reply. */
export function sendBackReason(event: unknown, reply: string, inCmux: boolean): string | null {
  if (!inCmux || field(event, "hook_event_name") !== "Stop") return null;
  if (field(event, "stop_hook_active") === true) return null;
  // No reply yet (not flushed, or an empty turn): nothing to judge.
  if (!reply.trim() || moveLine(reply) !== null) return null;
  return SEND_BACK_REASON;
}

if (import.meta.main) {
  try {
    const event: unknown = JSON.parse(readFileSync(0, "utf8"));
    const inCmux = !!process.env.CMUX_WORKSPACE_ID;
    // Only a turn that could be sent back reads its reply, so no other waits on the transcript.
    const couldSend = inCmux && field(event, "stop_hook_active") !== true;
    const reason = sendBackReason(event, couldSend ? finalReply(event) : "", inCmux);
    if (reason) console.log(JSON.stringify({ decision: "block", reason }));
  } catch (err) {
    console.error(`check-move: ${err instanceof Error ? err.message : String(err)}`);
  }
}
