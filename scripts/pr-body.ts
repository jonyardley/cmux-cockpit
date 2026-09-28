// CI check that a pull request's body fills in the sections the template
// asks for. "Look at after reload" matters because CI cannot run the cmux
// renderer; "Review" records the self-review before Jon's. A section counts
// as empty when it holds only the template's HTML comment, the Claude Code
// attribution footer, or a placeholder such as "Pending." standing in for the
// real text. Headings inside code fences do not end a section.

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

export const REQUIRED = ["Look at after reload", "Review"] as const;

const FOOTER = /^🤖 Generated with \[Claude Code\]\(.*\)\s*$/;

// Words that hold a section's place until the real text arrives, as their
// letters only, so "To do", "to-do" and "T.B.D." all match. Matched against
// whole lines, so real text that mentions one still counts.
const PLACEHOLDERS = new Set(["pending", "tbd", "tbc", "todo", "wip", "reviewpending", "pendingreview", "notyet"]);

// True when every line of the section with any letters is a placeholder or a
// sub-heading, and at least one is a placeholder. Case, spacing, punctuation
// and markdown ("- **Pending.**", "> TBD", "(wip)") are ignored.
function isPlaceholder(text: string): boolean {
  const words = text
    .split("\n")
    .filter((l) => !/^\s*#{1,6}\s/.test(l))
    .map((l) => l.replace(/[^\p{L}]/gu, "").toLowerCase())
    .filter((l) => l !== "");
  return words.length > 0 && words.every((w) => PLACEHOLDERS.has(w));
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

// The message to fail with, or null to pass.
export function bodyMessage(body: string): string | null {
  const missing = missingSections(body);
  if (missing.length === 0) return null;
  const names = missing.map((m) => `"## ${m}"`).join(" and ");
  return `pr-body: fill in the PR description's ${names} ${missing.length === 1 ? "section" : "sections"}.`;
}

// The same for a pull_request event. Takes the parsed event as unknown and
// narrows it, so a null or odd payload fails cleanly.
export function check(event: unknown): string | null {
  const pr = typeof event === "object" && event !== null && "pull_request" in event ? event.pull_request : null;
  const body = typeof pr === "object" && pr !== null && "body" in pr ? pr.body : null;
  return bodyMessage(typeof body === "string" ? body : "");
}

// The PR's live description from GitHub, via gh, or an Error saying why not.
// `pr` is anything `gh pr view` takes (number, URL, branch), or null for the
// current branch's PR in `cwd`.
export function fetchBody(pr: string | null, cwd?: string): string | Error {
  const args = ["pr", "view", ...(pr ? [pr] : []), "--json", "body", "--jq", ".body"];
  const r = spawnSync("gh", args, { cwd, encoding: "utf8" });
  if (r.error) return r.error;
  if (r.status !== 0) return new Error(r.stderr.trim() || `gh exited ${String(r.status)}`);
  return r.stdout;
}

// In CI it reads the event GitHub hands the job. Run by hand
// (`npm run pr-body [-- <pr>]`) it checks the PR's live description, so an
// unfinished one shows up before CI or `gh pr ready` does.
function main(): number {
  const path = process.env.GITHUB_EVENT_PATH;
  let message: string | null;
  if (path) {
    message = check(JSON.parse(readFileSync(path, "utf8")));
  } else {
    const body = fetchBody(process.argv[2] ?? null);
    if (body instanceof Error) {
      console.error(`pr-body: could not read the PR description. ${body.message}`);
      return 1;
    }
    message = bodyMessage(body);
  }
  if (message) console.error(message);
  else if (!path) console.log("pr-body: both required sections are filled in.");
  return message ? 1 : 0;
}

if (import.meta.main) process.exit(main());
