// Reading a Claude Code Bash event's command for gh PR calls, shared by the
// hooks that act on them (report-pr.ts, guard-ready.ts).

export function field(obj: unknown, key: string): unknown {
  return typeof obj === "object" && obj !== null && key in obj ? Reflect.get(obj, key) : undefined;
}

// `gh [global flags] pr <verb>` at the start of a shell segment, so a
// command that only mentions it (grep, a quoted body) does not count.
// Leading env assignments (`GH_REPO=o/r gh ...`) count too, and so does an
// `rtk` prefix: the RTK PreToolUse hook rewrites most commands to `rtk gh`,
// and RTK leaves some forms (a heredoc body, `gh -R`) as plain `gh`, so both
// must match.
export const ghPr = (verbs: string) =>
  new RegExp(String.raw`^\s*(?:\w+=\S*\s+)*(?:rtk\s+)?gh\s+(?:-\S+\s+(?:[^-\s]\S*\s+)?)*pr\s+(?:${verbs})(?![\w-])`);

export const SEGMENTS = /&&|\|\||[;|\n]/;
