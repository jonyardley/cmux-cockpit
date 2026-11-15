// Whether a checkout's sidebars are the ones cmux loads. cmux only reads
// ~/.config/cmux/sidebars (it ignores HOME and XDG_CONFIG_HOME, tested
// 2026-09-25), so a worktree's build or validate touches nothing on screen.

import { realpathSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";

// The path with links resolved, or null when it is not there.
function real(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

/**
 * True when `dir`'s sidebars are the ones cmux loads. `home` defaults to the
 * account's own home folder, not $HOME, since cmux ignores HOME too.
 */
export function isLiveCheckout(dir: string, home = userInfo().homedir): boolean {
  const mine = real(join(dir, "sidebars"));
  return mine !== null && mine === real(join(home, ".config", "cmux", "sidebars"));
}
