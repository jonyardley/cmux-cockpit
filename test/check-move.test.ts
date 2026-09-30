// When a turn is sent back for a closing line the sidebar can read: inside
// cmux, on Stop, once, and only when the reply has neither label. The
// stdin plumbing and the transcript read are not covered.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SEND_BACK_REASON, sendBackReason } from "../scripts/hooks/check-move.ts";

const stop = { hook_event_name: "Stop" };

describe("sendBackReason", () => {
  it("sends back a reply with no closing line", () => {
    assert.equal(sendBackReason(stop, "CI is running; I'll report when it lands.", true), SEND_BACK_REASON);
  });

  it("lets a reply with either label end, drifted wording included", () => {
    for (const reply of ["Done.\n\nYour move: go", "Nothing for you: CI runs.", "Nothing for you yet: CI runs."])
      assert.equal(sendBackReason(stop, reply, true), null, reply);
  });

  it("never sends back twice, outside cmux, off Stop, or with no reply to judge", () => {
    assert.equal(sendBackReason({ ...stop, stop_hook_active: true }, "Done.", true), null);
    assert.equal(sendBackReason(stop, "Done.", false), null);
    assert.equal(sendBackReason({ hook_event_name: "SubagentStop" }, "Done.", true), null);
    assert.equal(sendBackReason(stop, "  \n", true), null);
  });

  it("does not count a label inside a code fence", () => {
    assert.equal(sendBackReason(stop, "Opener:\n\n```\nYour move: go\n```", true), SEND_BACK_REASON);
  });
});
