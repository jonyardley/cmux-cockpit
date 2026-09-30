// A workspace's running background shells from the saved state: cmux sends
// custom sidebars none, so scripts/hooks/report-shell.ts records them in
// config/state.json. A shell counts only while the chat that started it is
// open, so one whose chat was closed, and its shell killed with it, never
// shows.

import { agentsOf } from "./needs.ts";
import { SAVED_STATE } from "./persist.ts";

/** How many background shells are running under the workspace's open chats. */
export function liveShellCount(w: Workspace | undefined): number {
  const map = SAVED_STATE.shells;
  if (!w || !map || !Object.hasOwn(map, w.id)) return 0;
  const open = new Set(agentsOf(w).flatMap((a) => (a.status === "ended" ? [] : [a.id])));
  return (map[w.id] ?? []).filter((s) => open.has(s.session)).length;
}
