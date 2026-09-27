// The published-links hook (#52): which PostToolUse events it records, the
// title and URL it reads from them, and how an entry folds into the saved
// map. The payloads follow report-pr.test.ts's shape (tool_name,
// tool_input, tool_response); what tool_response holds for the Artifact and
// Claude Docs tools is assumed, so the parser searches every string in it.
// The stdin, env, file lock and build spawn in main() are not covered.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";
import { applyPublished, publishedFrom, titleFromHtml } from "../scripts/hooks/report-published.ts";
import type { SavedPublished } from "../scripts/state-config.ts";
import { PUBLISHED_MAX_AGE_S as MAX_AGE_S } from "../src/shared/published-age.ts";

const PAGE = "https://claude.ai/code/artifact/0b3c9e2a-1f4d-4c6e-9a8b-7d6e5f4a3b2c";
const DOC = "https://claude.ai/artifact/H3otueVrHj1e6AfEbuQUoZ";
const NOW = 1_000_000;

const noFile = (): string | null => null;
const html = (text: string) => (): string | null => text;

const artifact = (input: Record<string, unknown>, response: unknown = `Published ${PAGE}`) => ({
  hook_event_name: "PostToolUse",
  tool_name: "Artifact",
  cwd: "/work",
  tool_input: input,
  tool_response: response,
});

const docs = (tool: string, input: Record<string, unknown>, response: unknown) => ({
  hook_event_name: "PostToolUse",
  tool_name: tool,
  tool_input: input,
  tool_response: response,
});

const createDoc = { container: { kind: "project", create: { name: "Release plan", doc: {} } }, batch: [] };

describe("publishedFrom: the Artifact tool", () => {
  it("records a publish as a page, titled from the page's <title>", () => {
    const event = artifact({ file_path: "/work/page.html" });
    assert.deepEqual(publishedFrom(event, "w1", NOW, html("<html><title>Lane board</title></html>")), {
      url: PAGE,
      title: "Lane board",
      kind: "page",
      workspace: "w1",
      epoch: NOW,
    });
  });

  it("reads the page relative to the event's cwd", () => {
    let asked = "";
    const read = (path: string): string | null => {
      asked = path;
      return "<title>x</title>";
    };
    publishedFrom(artifact({ file_path: "out/page.html" }), "w1", NOW, read);
    assert.equal(asked, "/work/out/page.html");
  });

  it("finds the URL anywhere in the result: a string, content blocks or an object", () => {
    const input = { file_path: "/work/p.html" };
    const blocks = [{ type: "text", text: `ok\n${PAGE}\nwatching` }];
    for (const response of [`${PAGE}`, blocks, { result: { url: PAGE } }]) {
      assert.equal(publishedFrom(artifact(input, response), "w1", NOW, noFile)?.url, PAGE);
    }
  });

  it("prefers the url it was asked to update over one the result mentions", () => {
    const event = artifact({ file_path: "/work/p.html", url: DOC }, `Updated ${PAGE}`);
    assert.equal(publishedFrom(event, "w1", NOW, noFile)?.url, DOC);
  });

  it("falls back to the title input, then the file's name, when the page has no <title>", () => {
    assert.equal(
      publishedFrom(artifact({ file_path: "/w/p.html", title: "Named" }), "w1", NOW, noFile)?.title,
      "Named",
    );
    assert.equal(publishedFrom(artifact({ file_path: "/w/lane-board.html" }), "w1", NOW, noFile)?.title, "lane-board");
    assert.equal(publishedFrom(artifact({ type_url: "https://x" }), "w1", NOW, noFile)?.title, "Untitled");
  });

  it("records a create from a type, titled from its title input", () => {
    const event = artifact({ type_url: "https://claude.ai/type/slides", title: "Deck" });
    assert.equal(publishedFrom(event, "w1", NOW, noFile)?.title, "Deck");
  });

  it("ignores every action but publish, and asset uploads", () => {
    for (const action of ["read", "list", "delete", "open", "pin", "unpin", "quickstart"]) {
      assert.equal(publishedFrom(artifact({ action, url: PAGE }), "w1", NOW, noFile), null, action);
    }
    assert.equal(publishedFrom(artifact({ url: PAGE, file_path: "/w/a.png", asset: true }), "w1", NOW, noFile), null);
    assert.notEqual(publishedFrom(artifact({ action: "publish", file_path: "/w/p.html" }), "w1", NOW, noFile), null);
  });

  it("skips links the call's own input names, such as the type or a source artifact", () => {
    const type = "https://claude.ai/artifact/slidesType";
    const source = "https://claude.ai/artifact/designSystem";
    const input = { type_url: type, title: "Deck", files: { "a.css": { artifact: source, path: "a.css" } } };
    const response = [
      { type: "text", text: `Type ${type}, design system ${source}` },
      { type: "text", text: PAGE },
    ];
    assert.equal(publishedFrom(artifact(input, response), "w1", NOW, noFile)?.url, PAGE);
  });

  it("ignores a publish whose result names no claude.ai artifact", () => {
    const event = artifact({ file_path: "/w/p.html" }, "Error: refused");
    assert.equal(publishedFrom(event, "w1", NOW, noFile), null);
    const other = artifact({ file_path: "/w/p.html" }, "see https://example.com/artifact/abc");
    assert.equal(publishedFrom(other, "w1", NOW, noFile), null);
  });
});

describe("publishedFrom: Claude Docs", () => {
  it("records a batch that creates a doc, titled from its name", () => {
    const event = docs("mcp__claude_ai_Claude_Docs__batch", createDoc, [{ type: "text", text: `Created ${DOC}` }]);
    assert.deepEqual(publishedFrom(event, "w1", NOW, noFile), {
      url: DOC,
      title: "Release plan",
      kind: "doc",
      workspace: "w1",
      epoch: NOW,
    });
  });

  it("ignores Docs' create tool, which only adds to an existing doc", () => {
    const event = docs("mcp__claude_ai_Claude_Docs__create", { title: "Notes" }, { url: DOC });
    assert.equal(publishedFrom(event, "w1", NOW, noFile), null);
  });

  it("ignores a batch that edits an existing doc", () => {
    const edit = { container: { kind: "project", id: "abc" }, batch: [{}] };
    assert.equal(publishedFrom(docs("mcp__claude_ai_Claude_Docs__batch", edit, `${DOC}`), "w1", NOW, noFile), null);
  });

  it("ignores other docs tools", () => {
    for (const tool of ["mcp__claude_ai_Claude_Docs__update", "mcp__claude_ai_Claude_Docs__create"]) {
      assert.equal(publishedFrom(docs(tool, createDoc, `${DOC}`), "w1", NOW, noFile), null, tool);
    }
  });
});

describe("publishedFrom: junk", () => {
  it("ignores other tools, other events and malformed payloads", () => {
    assert.equal(publishedFrom({ ...artifact({}), tool_name: "Bash" }, "w1", NOW, noFile), null);
    assert.equal(publishedFrom({ ...artifact({}), hook_event_name: "PreToolUse" }, "w1", NOW, noFile), null);
    assert.equal(publishedFrom({ tool_name: "Artifact", hook_event_name: "PostToolUse" }, "w1", NOW, noFile), null);
    assert.equal(publishedFrom(null, "w1", NOW, noFile), null);
    assert.equal(publishedFrom("x", "w1", NOW, noFile), null);
  });

  it("stops searching a result nested beyond reason", () => {
    let deep: unknown = PAGE;
    for (let i = 0; i < 50; i++) deep = { next: deep };
    assert.equal(publishedFrom(artifact({ file_path: "/w/p.html" }, deep), "w1", NOW, noFile), null);
  });

  it("cleans a title to one short line, and never leaves it empty", () => {
    const long = "x".repeat(500);
    const title = publishedFrom(artifact({ title: `a\n\tb ${long}` }), "w1", NOW, noFile)?.title ?? "";
    assert.ok(title.startsWith("a b x"));
    assert.equal(title.length, 120);
    assert.equal(publishedFrom(artifact({ title: " \n " }), "w1", NOW, noFile)?.title, "Untitled");
  });
});

describe("titleFromHtml", () => {
  it("reads the first <title>, decoding the common entities", () => {
    assert.equal(titleFromHtml("<head><TITLE lang=en> A &amp; B &lt;3&gt; </TITLE></head>"), " A & B <3> ");
    assert.equal(titleFromHtml("<title>Tom&#39;s &quot;page&quot;</title>"), `Tom's "page"`);
  });

  it("decodes numeric references and the common typographic names, leaving unknown ones", () => {
    assert.equal(
      titleFromHtml("<title>Jon&#8217;s &#x2014; notes&nbsp;&hellip;</title>"),
      "Jon\u2019s \u2014 notes \u2026",
    );
    assert.equal(titleFromHtml("<title>&bogus; &#0; &#x110000;</title>"), "&bogus; &#0; &#x110000;");
  });

  it("has none without a title", () => {
    assert.equal(titleFromHtml("<html></html>"), null);
    assert.equal(titleFromHtml("<title>unclosed"), null);
  });
});

describe("applyPublished", () => {
  const entry = (url: string, epoch: number, title = "T"): SavedPublished => ({
    url,
    title,
    kind: "page",
    workspace: "w1",
    epoch,
  });

  it("adds a new entry at the end", () => {
    const map = applyPublished({ [DOC]: entry(DOC, NOW - 10) }, entry(PAGE, NOW), NOW);
    assert.deepEqual(Object.keys(map), [DOC, PAGE]);
  });

  it("updates a republished URL in place, moving it last as the newest", () => {
    const start = { [PAGE]: entry(PAGE, NOW - 20, "Old"), [DOC]: entry(DOC, NOW - 10) };
    const map = applyPublished(start, entry(PAGE, NOW, "New"), NOW);
    assert.deepEqual(Object.keys(map), [DOC, PAGE]);
    assert.equal(map[PAGE]?.title, "New");
    assert.equal(Object.keys(start).length, 2, "the input is not changed");
  });

  it("drops entries older than seven days", () => {
    const old = entry(DOC, NOW - MAX_AGE_S - 1);
    const edge = entry("https://claude.ai/artifact/edge", NOW - MAX_AGE_S);
    const map = applyPublished({ [DOC]: old, [edge.url]: edge }, entry(PAGE, NOW), NOW);
    assert.deepEqual(Object.keys(map), [edge.url, PAGE]);
    assert.equal(MAX_AGE_S, 7 * 24 * 60 * 60);
  });

  it("prunes on a null entry too, so a pass with nothing new still drops the old", () => {
    const map = applyPublished({ [DOC]: entry(DOC, NOW - MAX_AGE_S - 1) }, null, NOW);
    assert.deepEqual(map, {});
  });
});

describe("the hook as Claude Code runs it", () => {
  // No CMUX_WORKSPACE_ID, so it can never write this checkout's state file.
  const env = { ...process.env };
  delete env.CMUX_WORKSPACE_ID;
  const run = (stdin: string) =>
    spawnSync(process.execPath, ["scripts/hooks/report-published.ts"], { input: stdin, env, encoding: "utf8" });

  it("exits 0 on junk, saying nothing", () => {
    const result = run("not json");
    assert.equal(result.status, 0);
    assert.equal(result.stderr, "");
  });

  it("exits 0 outside a cmux workspace, with a note on stderr", () => {
    const result = run(JSON.stringify(artifact({ file_path: "/nowhere/p.html" })));
    assert.equal(result.status, 0);
    assert.match(result.stderr, /report-published: skipped, not in a cmux workspace/);
  });
});
