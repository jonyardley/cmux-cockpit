// The PR reporter hook (#7): which events it acts on and the socket line it
// sends, and the delayed poll it starts. The socket write, the gh call and
// the spawn itself are not covered.

import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  createdPrUrl,
  delayedPoll,
  type Pr,
  parsePr,
  payload,
  SETTLE_DELAY_SECONDS,
  settledPr,
  stepFor,
} from "../scripts/hooks/report-pr.ts";

const URL = "https://github.com/o/r/pull/21";
const bash = (command: string, stdout = `${URL}\n`) => ({
  tool_name: "Bash",
  tool_input: { command },
  tool_response: { stdout, stderr: "" },
});

const PR: Pr = { number: 21, url: URL, state: "OPEN", headRefName: "pr-report" };
const ENV = { CMUX_TAB_ID: "tab1", CMUX_PANEL_ID: "panel1" };

describe("createdPrUrl", () => {
  it("returns the URL gh printed, wherever the command ran", () => {
    assert.equal(createdPrUrl(bash("cd /x && gh pr create --fill")), URL);
    assert.equal(createdPrUrl(bash("gh -R o/r pr new", `Creating pull request\n${URL}\n`)), URL);
  });

  it("takes the last URL, the one the create printed", () => {
    const out = "https://github.com/o/r/pull/20\nhttps://github.com/o/r/pull/21\n";
    assert.equal(createdPrUrl(bash("gh pr view 20 -q .url && gh pr create --fill", out)), URL);
  });

  it("sees a create that RTK rewrote to rtk gh, with RTK's own output", () => {
    // RTK prints "ok" per push step, then gh's URL, as seen on #41 and #42.
    const out = `ok\nremote: \nok\n${URL}\n`;
    assert.equal(createdPrUrl(bash("cd /x && rtk gh pr create --fill", out)), URL);
    assert.equal(createdPrUrl(bash("GH_REPO=o/r rtk gh pr create --fill", out)), URL);
    assert.equal(createdPrUrl(bash("rtk gh pr view 21", out)), null);
  });

  it("sees a create behind env assignments", () => {
    assert.equal(createdPrUrl(bash("GH_REPO=o/r gh pr create --fill")), URL);
    assert.equal(createdPrUrl(bash("A=1 B= gh pr new")), URL);
  });

  it("ignores a command that only mentions gh pr create", () => {
    assert.equal(createdPrUrl(bash('grep -rn "gh pr create" docs')), null);
    assert.equal(createdPrUrl(bash("echo gh pr create")), null);
  });

  it("ignores a create that printed no URL, so a failed create reports nothing", () => {
    assert.equal(createdPrUrl(bash("gh pr create", "")), null);
  });

  it("ignores other commands, other tools and junk", () => {
    assert.equal(createdPrUrl(bash("gh pr view 21")), null);
    assert.equal(createdPrUrl(bash("gh pr create-foo")), null);
    assert.equal(createdPrUrl({ ...bash("gh pr create"), tool_name: "Edit" }), null);
    assert.equal(createdPrUrl({ tool_name: "Bash", tool_input: { command: "gh pr create" } }), null);
    assert.equal(createdPrUrl(null), null);
  });
});

describe("parsePr", () => {
  it("reads gh pr view --json output", () => {
    assert.deepEqual(parsePr(JSON.stringify(PR)), PR);
  });

  it("refuses malformed or partial output", () => {
    assert.equal(parsePr("not json"), null);
    assert.equal(parsePr("[]"), null);
    assert.equal(parsePr(JSON.stringify({ ...PR, number: "21" })), null);
    assert.equal(parsePr(JSON.stringify({ ...PR, headRefName: undefined })), null);
  });
});

describe("payload", () => {
  it("writes the shell integration's report_pr line", () => {
    assert.equal(payload(PR, ENV), `report_pr 21 ${URL} --state=open --branch="pr-report" --tab=tab1 --panel=panel1`);
  });

  it("escapes quotes in the branch as the shell integration does", () => {
    assert.match(payload({ ...PR, headRefName: 'a"b' }, ENV) ?? "", / --branch="a\\"b" /);
  });

  it("wraps the line only for a capability without whitespace", () => {
    assert.match(payload(PR, { ...ENV, CMUX_SOCKET_CAPABILITY: "cap" }) ?? "", /^_cmux_capability_v1 cap report_pr /);
    assert.match(payload(PR, { ...ENV, CMUX_SOCKET_CAPABILITY: "a b" }) ?? "", /^report_pr /);
  });

  it("gives up without cmux ids or on an unknown state", () => {
    assert.equal(payload(PR, { CMUX_TAB_ID: "tab1" }), null);
    assert.equal(payload({ ...PR, state: "DRAFT" }, ENV), null);
    assert.equal(payload({ ...PR, state: "constructor" }, ENV), null);
  });

  it("gives up on a field with whitespace that would split the line", () => {
    assert.equal(payload(PR, { ...ENV, CMUX_PANEL_ID: "panel 1" }), null);
    assert.equal(payload({ ...PR, url: `${URL} x` }, ENV), null);
  });
});

describe("settledPr", () => {
  it("sees gh pr ready and gh pr merge, however gh was started", () => {
    assert.equal(settledPr(bash("gh pr ready 68")), true);
    assert.equal(settledPr(bash("cd /x && rtk gh pr merge 68 --squash")), true);
    assert.equal(settledPr(bash("GH_REPO=o/r gh -R o/r pr ready")), true);
    assert.equal(settledPr(bash("npm run check && gh pr ready")), true);
    assert.equal(settledPr(bash("gh pr close 68")), true);
    assert.equal(settledPr(bash("gh pr reopen 68")), true);
  });

  it("leaves a backgrounded call to the turn-end poll, since the hook fires before gh runs", () => {
    const event = bash("npm run check && gh pr ready 70");
    assert.equal(settledPr({ ...event, tool_input: { ...event.tool_input, run_in_background: true } }), false);
  });

  it("ignores mentions, other gh pr commands, other tools and junk", () => {
    assert.equal(settledPr(bash('grep -rn "gh pr ready" docs')), false);
    assert.equal(settledPr(bash("gh pr view 68")), false);
    assert.equal(settledPr(bash("gh pr create --fill")), false);
    assert.equal(settledPr(bash("gh pr merge-foo")), false);
    assert.equal(settledPr({ ...bash("gh pr ready"), tool_name: "Edit" }), false);
    assert.equal(settledPr(null), false);
  });
});

describe("stepFor", () => {
  it("reports a create, polls after a settle, and does nothing otherwise", () => {
    assert.deepEqual(stepFor(bash("gh pr create --fill")), { kind: "report", url: URL });
    assert.deepEqual(stepFor(bash("gh pr merge 21 --squash", "")), { kind: "poll" });
    assert.equal(stepFor(bash("gh pr view 21")), null);
    assert.equal(stepFor(null), null);
  });

  it("does nothing for a create that printed no URL", () => {
    assert.equal(stepFor(bash("gh pr create", "")), null);
  });
});

describe("delayedPoll", () => {
  it("runs this checkout's pr-poll.ts with the hook's node after a delay, with no shell", () => {
    const root = join("/repo", "cmux");
    assert.deepEqual(delayedPoll(join(root, "scripts", "hooks"), "/bin/node"), {
      command: "/bin/node",
      args: [join(root, "scripts", "pr-poll.ts"), "--delay", "10"],
      cwd: root,
    });
  });

  it("takes a shorter delay for a ready or merge", () => {
    const root = join("/repo", "cmux");
    const poll = delayedPoll(join(root, "scripts", "hooks"), "/bin/node", SETTLE_DELAY_SECONDS);
    assert.deepEqual(poll.args, [join(root, "scripts", "pr-poll.ts"), "--delay", "1"]);
  });
});
