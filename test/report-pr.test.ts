// The PR reporter hook (#7): which events it acts on and the socket line it
// sends. The socket write and the gh call are not covered.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createdPrUrl, type Pr, parsePr, payload } from "../scripts/hooks/report-pr.ts";

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
  });
});
