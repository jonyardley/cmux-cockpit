// Small pieces shared by the agents panel's sections.

import { prChipColors, shownHealth } from "../../shared/pr-colors.ts";
import type { Project } from "../../shared/projects.ts";
import { chipFrame, chipText, countPill, haloDot, projectBadge, ring, sectionTitle, when } from "../../shared/ui.ts";
import { chatTarget, type PrEntry, prChipHealth, prChipText, prDim } from "../pr-list.ts";
import { STALE_OPACITY, T } from "../theme.ts";

// White panel with a hairline edge: the runtime has no shadows, so depth is
// the edge against the tinted ground.
export function panel(children: View[]): View {
  return ring(VStack({ spacing: 0, alignment: "leading" }, children), T.panel, T.panelEdge, 1, 12).frame({
    maxWidth: "infinity",
    alignment: "leading",
  });
}

// Row followed by a hairline rule, hidden on the panel's last row.
export function ruled(row: View | readonly View[], isLast: () => boolean): View {
  return VStack({ spacing: 0, alignment: "leading" }, [
    ...(Array.isArray(row) ? row : [row]),
    Rectangle()
      .fill(T.rule)
      .frame({ maxWidth: "infinity", height: () => (isLast() ? 0 : 1) }),
  ]).frame({ maxWidth: "infinity", alignment: "leading" });
}

export function sectionHeader(label: Reactive<string>, count?: () => string, dot?: string): View {
  // A zero-width dot would still cost the HStack spacing and indent the label.
  return HStack({ spacing: 7 }, [
    ...(dot ? [Circle({ size: 7 }).fill(dot)] : []),
    sectionTitle(label, T.secondary),
    // The shared grey pill; an empty count shows none.
    countPill(() => (count ? count() : "")),
    Spacer(),
  ])
    .paddingHorizontal(4)
    .paddingBottom(2);
}

// Status dot, or a hollow grey ring while `hollow()` holds (idle, no agent).
// Both circles stay mounted so the dot can switch in place.
export function agentDot(color: () => string, halo: () => string, hollow: () => boolean): View {
  const dot = Circle({ size: 7 })
    .fill(() => (hollow() ? "clear" : color()))
    .stroke(() => (hollow() ? T.grey : "clear"))
    .strokeWidth(1.5);
  return haloDot(dot, () => (hollow() ? "clear" : halo()), 7);
}

// Reactive, so a row whose key outlives its project (a Made here row, keyed
// by link, whose workspace loads late or closes) still follows it.
export const glyph = (p: () => Project, size = 18): View => projectBadge(p, size, size / 2);

/** Selects the workspace, then focuses the agent's surface when it has one. */
export function jump(wsId: string, surfaceId: string | undefined): void {
  cmux("workspace.select", { workspace_id: wsId });
  if (surfaceId) cmux("surface.focus", { surface_id: surfaceId, workspace_id: wsId });
}

/** A row with a right-click Open chat while it has a workspace to go to
 * (model.ts chatWs). Two `when`s, since a row's menu is fixed when it is
 * built and a ForEach row's kind is fixed by its key; returned bare, for
 * ruled to hold, so no stack is added round the row. */
export function withChatMenu(row: () => View, chat: () => string | undefined): View[] {
  const open = () => {
    const t = chatTarget(chat() ?? "");
    if (t) jump(t.wsId, t.surfaceId);
  };
  return [
    when(
      "chat",
      () => !!chat(),
      () => row().contextMenu([Button("Open chat", open)]),
    ),
    when("plain", () => !chat(), row),
  ];
}

/** A PR's state chip, "draft": its words on a faint face of its health's hue,
 * dimmed while stale. No tap of its own: its row opens the PR. */
export function prChip(e: () => PrEntry): View {
  const colors = () => prChipColors(shownHealth(prChipHealth(e()), prDim(e())));
  return chipFrame(
    chipText(
      () => prChipText(e()),
      () => colors().fg,
    ),
    colors,
  ).opacity(() => (prDim(e()) ? STALE_OPACITY : 1));
}
