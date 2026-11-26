// Small pieces shared by the agents panel's sections.

import { prChipColors } from "../../shared/pr-colors.ts";
import type { Project } from "../../shared/projects.ts";
import { chipFrame, chipText, countPill, haloDot, projectBadge, ring, sectionTitle } from "../../shared/ui.ts";
import { chooseMenuItem, type MenuEntry, menuKey, tidyMenu } from "../menus.ts";
import { type PrEntry, prChipText, prChipTone, prDim } from "../pr-list.ts";
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

export function withMenu(row: () => View, items: () => readonly MenuEntry[]): View {
  const shown = () => tidyMenu(items());
  return ForEach({ items: () => [{ id: menuKey(shown()) }], key: (x) => x.id }, () => {
    const now = shown();
    if (now.length === 0) return row();
    return row().contextMenu(
      now.map((i) => (i === "divider" ? Divider() : Button(i.label, () => chooseMenuItem(shown(), i.label)))),
    );
  });
}

/** A PR's state chip, "draft": its words on a faint face of its tone's hue,
 * dimmed while stale. No tap of its own: its row opens the PR. */
export function prChip(e: () => PrEntry): View {
  const colors = () => prChipColors(prChipTone(e()));
  return chipFrame(
    chipText(
      () => prChipText(e()),
      () => colors().fg,
    ),
    colors,
  ).opacity(() => (prDim(e()) ? STALE_OPACITY : 1));
}
