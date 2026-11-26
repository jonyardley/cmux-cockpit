// Right-click menus: the items a row offers and what each one does when chosen.

import { mostActive } from "../shared/activity.ts";
import { agentsOf } from "../shared/needs.ts";
import { openIfUrl } from "../shared/ui.ts";

export type MenuAction =
  | { open: string }
  | { copy: string }
  | { chat: string }
  | { agent: { wsId: string; surfaceId: string | undefined } };

export type MenuEntry = { label: string; does: MenuAction } | "divider";

/** Selects the workspace, then focuses the agent's surface when it has one. */
export function jump(wsId: string, surfaceId: string | undefined): void {
  cmux("workspace.select", { workspace_id: wsId });
  if (surfaceId) cmux("surface.focus", { surface_id: surfaceId, workspace_id: wsId });
}

// Read when chosen, so it focuses the agent the panel leads with then.
function goToChat(wsId: string): boolean {
  const w = (data.workspaces() ?? []).find((x) => x.id === wsId);
  if (!w) return false;
  jump(wsId, mostActive(agentsOf(w))?.surfaceId);
  return true;
}

export function runMenu(does: MenuAction): boolean {
  if ("open" in does) {
    openIfUrl(does.open);
    return true;
  }
  // The panel has no line for a failed action, so a refused write only returns false here.
  if ("copy" in does) return clipboard.write(does.copy);
  if ("agent" in does) {
    jump(does.agent.wsId, does.agent.surfaceId);
    return true;
  }
  return goToChat(does.chat);
}

// By label, not position: the list can change while the menu is open.
export function chooseMenuItem(items: readonly MenuEntry[], label: string): boolean {
  const item = items.find((i) => i !== "divider" && i.label === label);
  return item !== undefined && item !== "divider" && runMenu(item.does);
}

export function tidyMenu(items: readonly MenuEntry[]): MenuEntry[] {
  const out: MenuEntry[] = [];
  for (const i of items) {
    if (i === "divider" && (out.length === 0 || out.at(-1) === "divider")) continue;
    out.push(i);
  }
  if (out.at(-1) === "divider") out.pop();
  return out;
}

// A built menu is fixed, so a row is keyed by its labels and rebuilt when they change.
export const menuKey = (items: readonly MenuEntry[]): string =>
  "menu:" + items.map((i) => (i === "divider" ? "-" : i.label)).join("|");
