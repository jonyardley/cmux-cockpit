// Finds the cmux-cockpit checkout a file belongs to, so the Claude Code
// hooks work the same for the main checkout, a sibling worktree, and a
// file in some other repo (which they leave alone).

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

const NAME = "cmux-cockpit";

export function checkoutRoot(filePath: string): string | null {
  let dir = dirname(filePath);
  for (;;) {
    const pkg = join(dir, "package.json");
    if (existsSync(pkg)) {
      // A package.json we did not write may hold anything, so read the
      // name defensively rather than trusting its shape.
      const parsed: unknown = JSON.parse(readFileSync(pkg, "utf8"));
      const name = typeof parsed === "object" && parsed !== null && "name" in parsed ? parsed.name : null;
      return name === NAME ? dir : null;
    }
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}
