// A chat's running background shells from the saved state: cmux sends
// custom sidebars none, so scripts/hooks/report-shell.ts records them in
// config/state.json. A shell counts only for the chat that started it and
// only while that chat is open, so one whose chat was closed, and its
// shell killed with it, never shows.

import { SAVED_STATE } from "./persist.ts";

/** How many background shells the agent's chat has running in the workspace; none once it has ended. */
export function liveShellCount(w: Workspace | undefined, a: Agent | null): number {
  const map = SAVED_STATE.shells;
  if (!w || !a || a.status === "ended" || !map || !Object.hasOwn(map, w.id)) return 0;
  return (map[w.id] ?? []).filter((s) => s.session === a.id).length;
}
