// Small pieces shared by the agents panel's sections.

import type { Project } from "../../shared/projects.ts";
import { haloDot, projectBadge, ring, sectionTitle } from "../../shared/ui.ts";
import { T } from "../theme.ts";

// White panel with a hairline edge: the runtime has no shadows, so depth is
// the edge against the tinted ground.
export function panel(children: View[]): View {
  return ring(VStack({ spacing: 0, alignment: "leading" }, children), T.panel, T.panelEdge, 1, 12).frame({
    maxWidth: "infinity",
    alignment: "leading",
  });
}

// Row followed by a hairline rule, hidden on the panel's last row.
export function ruled(row: View, isLast: () => boolean): View {
  return VStack({ spacing: 0, alignment: "leading" }, [
    row,
    Rectangle()
      .fill(T.rule)
      .frame({ maxWidth: "infinity", height: () => (isLast() ? 0 : 1) }),
  ]).frame({ maxWidth: "infinity", alignment: "leading" });
}

export function sectionHeader(label: string, count?: () => string, dot?: string): View {
  const n = () => (count ? count() : "");
  // A zero-width dot would still cost the HStack spacing and indent the label.
  return HStack({ spacing: 7 }, [
    ...(dot ? [Circle({ size: 7 }).fill(dot)] : []),
    sectionTitle(label, T.secondary),
    Text(n)
      .font(10.5)
      .weight("medium")
      .color(T.metaText)
      .paddingHorizontal(() => (n() ? 7 : 0))
      .paddingVertical(1)
      .background(() => (n() ? T.countBg : "clear"))
      .cornerRadius(10),
    Spacer(),
  ])
    .paddingHorizontal(4)
    .paddingBottom(2);
}

// Status dot over board 2's soft halo; pass "clear" for no halo.
export function statusDot(color: Reactive<string>, halo: Reactive<string>): View {
  return haloDot(Circle({ size: 7 }).fill(color), halo, 7);
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

/** The hollow grey ring idle rows lead with. */
export function idleRing(): View {
  return agentDot(
    () => T.grey,
    () => "clear",
    () => true,
  );
}

// Reactive, so a row whose key outlives its project (a Made here row, keyed
// by link, whose workspace loads late or closes) still follows it.
export const glyph = (p: () => Project): View => projectBadge(p, 18, 9);

/** Selects the workspace, then focuses the agent's surface when it has one. */
export function jump(wsId: string, surfaceId: string | undefined): void {
  cmux("workspace.select", { workspace_id: wsId });
  if (surfaceId) cmux("surface.focus", { surface_id: surfaceId, workspace_id: wsId });
}

export function openIfUrl(url: string | undefined): void {
  if (url) openURL(url);
}
