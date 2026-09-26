// CI check that a pull request's body fills in the sections the template
// asks for. "Look at after reload" matters because CI cannot run the cmux
// renderer; "Review" records the self-review before Jon's. A section counts
// as empty when it holds only the template's HTML comment, the Claude Code
// attribution footer, or a placeholder such as "Pending." standing in for the
// real text. Headings inside code fences do not end a section.

import { readFileSync } from "node:fs";

export const REQUIRED = ["Look at after reload", "Review"] as const;

const FOOTER = /^🤖 Generated with \[Claude Code\]\(.*\)\s*$/;

// Words that hold a section's place until the real text arrives. Matched
// against the whole section, so real text that mentions one still counts.
const PLACEHOLDERS = new Set(["pending", "tbd", "todo", "wip", "to do", "review pending", "not yet"]);

// True when the section's text is only a placeholder, ignoring case, spacing,
// trailing punctuation and wrapping emphasis ("**Pending.**").
function isPlaceholder(text: string): boolean {
  const bare = text
    .replace(/^[\s*_`]+/, "")
    .replace(/[\s*_`.!?:;,\u2026]+$/, "")
    .replace(/\s+/g, " ")
    .toLowerCase();
  return PLACEHOLDERS.has(bare);
}

// Lines of the body with comments and the footer removed, and each line
// flagged when it is a real "## " heading rather than one inside a fence.
function lines(body: string): { text: string; heading: boolean }[] {
  let fenced = false;
  return body
    .replace(/<!--[\s\S]*?-->/g, "")
    .split("\n")
    .filter((l) => !FOOTER.test(l))
    .map((text) => {
      if (/^\s*(```|~~~)/.test(text)) fenced = !fenced;
      return { text, heading: !fenced && /^## /.test(text) };
    });
}

export function missingSections(body: string): string[] {
  const all = lines(body);
  return REQUIRED.filter((name) => {
    const at = all.findIndex((l) => l.heading && l.text.trim() === `## ${name}`);
    if (at === -1) return true;
    const rest = all.slice(at + 1);
    const end = rest.findIndex((l) => l.heading);
    const text = (end === -1 ? rest : rest.slice(0, end)).map((l) => l.text).join("\n");
    return text.trim() === "" || isPlaceholder(text);
  });
}

// The message to fail with, or null to pass. Takes the parsed event as
// unknown and narrows it, so a null or odd payload fails cleanly.
export function check(event: unknown): string | null {
  const pr = typeof event === "object" && event !== null && "pull_request" in event ? event.pull_request : null;
  const body = typeof pr === "object" && pr !== null && "body" in pr ? pr.body : null;
  const missing = missingSections(typeof body === "string" ? body : "");
  if (missing.length === 0) return null;
  const names = missing.map((m) => `"## ${m}"`).join(" and ");
  return `pr-body: fill in the PR description's ${names} ${missing.length === 1 ? "section" : "sections"}.`;
}

function main(): number {
  const path = process.env.GITHUB_EVENT_PATH;
  if (!path) {
    console.error("pr-body: GITHUB_EVENT_PATH is not set");
    return 1;
  }
  const message = check(JSON.parse(readFileSync(path, "utf8")));
  if (message) console.error(message);
  return message ? 1 : 0;
}

if (import.meta.main) process.exit(main());
