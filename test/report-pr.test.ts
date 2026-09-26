// The PR reporter hook (#7): which events it acts on and the socket line it
// sends. The socket write and the gh call are not covered.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type Pr, parsePr, payload, prCreateCwd } from "../scripts/report-pr.ts";

const bash = (command: string) => ({ tool_name: "Bash", cwd: "/repo", tool_input: { command } });

const PR: Pr = { number: 21, url: "https://github.com/o/r/pull/21", state: "OPEN", headRefName: "pr-report" };
const ENV = { CMUX_TAB_ID: "tab1", CMUX_PANEL_ID: "panel1" };

describe("prCreateCwd", () => {
  it("returns the cwd after gh pr create, even inside a longer command", () => {
    assert.equal(prCreateCwd(bash("cd /x && gh pr create --fill")), "/repo");
  });

  it("ignores other gh commands, other tools and junk", () => {
    assert.equal(prCreateCwd(bash("gh pr view 3")), null);
    assert.equal(prCreateCwd({ ...bash("gh pr create"), tool_name: "Edit" }), null);
    assert.equal(prCreateCwd({ tool_name: "Bash", tool_input: { command: "gh pr create" } }), null);
    assert.equal(prCreateCwd(null), null);
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
    assert.equal(
      payload(PR, ENV),
      "report_pr 21 https://github.com/o/r/pull/21 --state=open --branch=pr-report --tab=tab1 --panel=panel1",
    );
  });

  it("wraps the line when the socket wants a capability", () => {
    assert.match(
      payload(PR, { ...ENV, CMUX_SOCKET_CAPABILITY: "cap" }) ?? "",
      /^_cmux_capability_v1 cap report_pr 21 /,
    );
  });

  it("gives up without cmux ids or on a field with whitespace", () => {
    assert.equal(payload(PR, { CMUX_TAB_ID: "tab1" }), null);
    assert.equal(payload({ ...PR, headRefName: "a b" }, ENV), null);
  });
});
