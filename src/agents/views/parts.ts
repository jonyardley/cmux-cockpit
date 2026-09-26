// Small pieces shared by the agents panel's sections.

import type { Project } from "../../shared/projects.ts";
import { haloDot } from "../../shared/ui.ts";
import { type ChipColors, T } from "../theme.ts";

// Edge as a filled ring: the edge colour fills an outer rounded box and the
// face sits inset by the edge width. A borderWidth stroke is clipped by the
// corner radius and thins out round every corner. `hug` keeps the face at its
// content width (chips, buttons) instead of filling the row.
export function ring(
  view: View,
  face: Reactive<string>,
  edge: Reactive<string>,
  width: number,
  radius: number,
  hug = false,
): View {
  const inner = view.background(face).cornerRadius(radius - width);
  return VStack({ spacing: 0, alignment: "leading" }, [
    hug ? inner : inner.frame({ maxWidth: "infinity", alignment: "leading" }),
  ])
    .padding(width)
    .background(edge)
    .cornerRadius(radius);
}

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
    Text(label).font(10.5).weight("semibold").color(T.secondary),
    Text(n)
      .font(10.5)
      .weight("medium")
      .color("#6B6A64")
      .paddingHorizontal(() => (n() ? 7 : 0))
      .paddingVertical(1)
      .background(() => (n() ? "#E5E2D6" : "clear"))
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

export function meta(fn: () => string): View {
  return Text(fn).font(12).monospaced().color(T.secondary).lineLimit(1).layoutPriority(2);
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

export function glyph(p: Project): View {
  return ZStack({}, [
    RoundedRectangle({ cornerRadius: 5 }).fill(p.color),
    Image(p.icon).font(9).color("#FFFFFF"),
  ]).frame({ width: 18, height: 18 });
}

export function chip(label: () => string, colors: () => ChipColors): View {
  return ring(
    Text(label)
      .font(11)
      .weight("medium")
      .lineLimit(1)
      .paddingHorizontal(6)
      .paddingVertical(1)
      .color(() => colors().fg),
    () => colors().bg,
    () => colors().edge,
    1,
    6,
    true,
  );
}

export function emptyRow(text: string): View {
  return Text(text)
    .font(12)
    .color(T.tertiary)
    .paddingHorizontal(12)
    .paddingVertical(10)
    .frame({ maxWidth: "infinity", alignment: "leading" });
}

/** Selects the workspace, then focuses the agent's surface when it has one. */
export function jump(wsId: string, surfaceId: string | undefined): void {
  cmux("workspace.select", { workspace_id: wsId });
  if (surfaceId) cmux("surface.focus", { surface_id: surfaceId, workspace_id: wsId });
}

export function openIfUrl(url: string | undefined): void {
  if (url) openURL(url);
}
