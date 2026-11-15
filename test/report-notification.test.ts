// The pure parts of the notification hook (#81): which Claude Code hook
// events count as an ask, and the short reason each one saves. The file
// write, the rebuild and the stdin/env plumbing are not covered.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  askFrom,
  commandWords,
  notificationReason,
  permissionReason,
  REUSE_S,
} from "../scripts/hooks/report-notification.ts";
import { applySet, emptyState, MAX_LABEL } from "../scripts/state-config.ts";

const permission = (tool: string, input: unknown = {}, session = "s1") => ({
  hook_event_name: "PermissionRequest",
  session_id: session,
  tool_name: tool,
  tool_input: input,
});

const notification = (type: string, message?: string, session = "s1", title?: string) => ({
  hook_event_name: "Notification",
  session_id: session,
  notification_type: type,
  message,
  title,
});

const reasonOf = (event: unknown): string | undefined => askFrom(event, 1000)?.reason;

describe("commandWords", () => {
  it("names the first two words of the first segment that is not a cd", () => {
    assert.equal(commandWords("git push origin main"), "git push");
    assert.equal(commandWords("cd /repo && git push"), "git push");
    assert.equal(commandWords("  npm   ci  "), "npm ci");
    assert.equal(commandWords("ls"), "ls");
  });

  it("skips env assignments and wrapper words", () => {
    assert.equal(commandWords("GH_REPO=o/r rtk gh pr merge 3"), "gh pr");
    assert.equal(commandWords("sudo rm -rf /tmp/x"), "rm");
  });

  it("skips flags, a flag's path value, quoted text and subshell brackets", () => {
    assert.equal(commandWords("git -C /Users/jon/repo push"), "git push");
    assert.equal(commandWords("npm --prefix ~/.config/cmux run build"), "npm run");
    assert.equal(commandWords('grep "a|b" f'), "grep f");
    assert.equal(commandWords("echo 'x; y' | wc"), "echo");
    assert.equal(commandWords("(cd x && make)"), "make");
  });

  it("is null when nothing is left to name", () => {
    assert.equal(commandWords(""), null);
    assert.equal(commandWords("cd /repo"), null);
    assert.equal(commandWords("FOO=1 && cd x"), null);
  });
});

describe("permissionReason", () => {
  it("names the command, file, host or tool Claude Code is asking about", () => {
    assert.equal(permissionReason(permission("Bash", { command: "cd /r && git push" })), "allow git push?");
    assert.equal(permissionReason(permission("Bash", { command: "cd /r" })), "allow a command?");
    assert.equal(permissionReason(permission("Bash", {})), "allow a command?");
    assert.equal(permissionReason(permission("Edit", { file_path: "/r/src/a.ts" })), "allow edit a.ts?");
    assert.equal(permissionReason(permission("Write", { file_path: "/r/b.md" })), "allow write b.md?");
    assert.equal(permissionReason(permission("NotebookEdit", { notebook_path: "/r/n.ipynb" })), "allow edit n.ipynb?");
    assert.equal(permissionReason(permission("MultiEdit", {})), "allow edit?");
    assert.equal(
      permissionReason(permission("WebFetch", { url: "https://example.com/x" })),
      "allow fetch example.com?",
    );
    assert.equal(permissionReason(permission("WebFetch", { url: "not a url" })), "allow a fetch?");
    assert.equal(permissionReason(permission("WebFetch", {})), "allow a fetch?");
    assert.equal(permissionReason(permission("mcp__claude_ai_Slack__slack_send_message")), "allow slack_send_message?");
    assert.equal(permissionReason(permission("Skill")), "allow Skill?");
  });

  it("uses a question's own words and says a plan wants approving", () => {
    const ask = permission("AskUserQuestion", { questions: [{ question: "  Which\nlayout? " }, { question: "x" }] });
    assert.equal(permissionReason(ask), "Which layout?");
    assert.equal(permissionReason(permission("AskUserQuestion", { questions: [] })), "a question");
    assert.equal(permissionReason(permission("AskUserQuestion", { questions: "nope" })), "a question");
    assert.equal(permissionReason(permission("ExitPlanMode", { plan: "..." })), "approve the plan?");
  });

  it("falls back when the tool name is missing or unusable", () => {
    assert.equal(permissionReason({ hook_event_name: "PermissionRequest" }), "allow a tool?");
    assert.equal(permissionReason(permission("Bash", { command: 7 })), "allow a command?");
  });

  it("keeps a long reason within the saved label's length", () => {
    const reason = permissionReason(permission("AskUserQuestion", { questions: [{ question: "q".repeat(500) }] }));
    assert.equal(reason.length, MAX_LABEL);
  });
});

describe("notificationReason", () => {
  it("turns Claude Code's permission message into the tool it names", () => {
    assert.equal(
      notificationReason(
        notification("permission_prompt", "Claude needs your permission to use Bash"),
        "permission_prompt",
      ),
      "allow Bash?",
    );
  });

  it("uses the message, then the title, then a word for the kind of ask", () => {
    assert.equal(
      notificationReason(notification("elicitation_dialog", "Pick a repo"), "elicitation_dialog"),
      "Pick a repo",
    );
    assert.equal(
      notificationReason(notification("elicitation_url_dialog", "", "s1", "Sign in"), "elicitation_url_dialog"),
      "Sign in",
    );
    assert.equal(
      notificationReason(notification("elicitation_url_dialog"), "elicitation_url_dialog"),
      "a link to open",
    );
    assert.equal(
      notificationReason(
        notification(
          "permission_prompt",
          "Claude needs your permission to use mcp__claude_ai_Slack__slack_send_message",
        ),
        "permission_prompt",
      ),
      "allow slack_send_message?",
    );
    assert.equal(notificationReason(notification("permission_prompt"), "permission_prompt"), "needs permission");
    assert.equal(notificationReason(notification("x"), "x"), "needs you");
  });
});

describe("askFrom", () => {
  it("records a PermissionRequest with the session and the time it was heard", () => {
    assert.deepEqual(askFrom(permission("Bash", { command: "git push" }), 1000), {
      reason: "allow git push?",
      epoch: 1000,
      session: "s1",
    });
  });

  it("records the two blocking tools from PreToolUse, and no other tool", () => {
    const pre = (tool: string, input: unknown = {}) => ({
      hook_event_name: "PreToolUse",
      session_id: "s",
      tool_name: tool,
      tool_input: input,
    });
    assert.equal(reasonOf(pre("ExitPlanMode")), "approve the plan?");
    assert.equal(reasonOf(pre("AskUserQuestion", { questions: [{ question: "Ship it?" }] })), "Ship it?");
    assert.equal(askFrom(pre("Bash", { command: "ls" }), 1000), null);
  });

  it("records the notification kinds that ask, never the turn-end nudge or others", () => {
    for (const type of ["permission_prompt", "elicitation_dialog", "elicitation_url_dialog"])
      assert.notEqual(askFrom(notification(type, "m"), 1000), null, type);
    for (const type of ["idle_prompt", "agent_needs_input", "auth_success", "agent_completed", "__proto__"])
      assert.equal(askFrom(notification(type, "m"), 1000), null, type);
    assert.equal(askFrom({ hook_event_name: "Notification", message: "m" }, 1000), null);
  });

  it("writes nothing for the same session's permission_prompt that follows its PermissionRequest", () => {
    // Rewriting would restamp the ask and cost a second rebuild; the saved
    // ask keeps its reason and its own time.
    const saved = { reason: "allow git push?", epoch: 1000, session: "s1" };
    const prompt = notification("permission_prompt", "Claude needs your permission to use Bash");
    assert.equal(askFrom(prompt, 1006, saved), null);
    assert.equal(askFrom(prompt, 1000 + REUSE_S, saved), null);
  });

  it("uses the notification's own reason for another session, an old ask or another kind", () => {
    const saved = { reason: "allow git push?", epoch: 1000, session: "s1" };
    const prompt = notification("permission_prompt", "Claude needs your permission to use Bash");
    assert.equal(
      askFrom(notification("permission_prompt", "Claude needs your permission to use Bash", "s2"), 1006, saved)?.reason,
      "allow Bash?",
    );
    assert.equal(askFrom(prompt, 1001 + REUSE_S, saved)?.reason, "allow Bash?");
    assert.equal(askFrom(notification("elicitation_dialog", "Pick one"), 1006, saved)?.reason, "Pick one");
    assert.equal(askFrom(prompt, 1006, { reason: "allow git push?", epoch: 1000 })?.reason, "allow Bash?");
    const noSession = { hook_event_name: "Notification", notification_type: "permission_prompt", message: "m" };
    assert.equal(askFrom(noSession, 1006, { reason: "r", epoch: 1000 })?.reason, "m");
  });

  it("leaves out a session id that is missing or would not be saved", () => {
    assert.deepEqual(askFrom({ hook_event_name: "PermissionRequest", tool_name: "Bash" }, 5), {
      reason: "allow a command?",
      epoch: 5,
    });
    assert.equal(askFrom(permission("Bash", {}, "s".repeat(129)), 5)?.session, undefined);
    assert.equal(askFrom(permission("Bash", {}, "constructor"), 5)?.session, undefined);
    assert.equal(askFrom(permission("Bash", {}, "a b"), 5)?.session, undefined);
  });

  it("ignores anything that is not a hook event it knows", () => {
    for (const event of [undefined, null, 7, "x", [], {}, { hook_event_name: "Stop" }])
      assert.equal(askFrom(event, 1), null);
  });

  it("always makes an entry the state file accepts", () => {
    const events = [
      permission("AskUserQuestion", { questions: [{ question: `\u0007${"x".repeat(300)}` }] }),
      notification("elicitation_dialog", "  "),
      permission("Bash", { command: "cd a && git push" }, "sess-1"),
    ];
    for (const event of events) {
      const ask = askFrom(event, 42);
      const set = applySet(emptyState(), "asking.w1", JSON.stringify(ask));
      assert.equal(set.ok, true);
      if (set.ok) assert.deepEqual(set.state.asking.w1, ask);
    }
  });
});
