// View helpers shared by both sidebars.

import { glyphColor } from "./contrast.ts";
import { P } from "./palette.ts";
import type { ChipColors } from "./pr-colors.ts";
import type { Project } from "./projects.ts";
import { tracked } from "./text.ts";

/**
 * Shows `view` only while `pred()` is true (a ForEach over zero or one item).
 * A layoutPriority set inside `view` does not reach the parent stack, so set it
 * on the `when()` result.
 */
export function when(key: string, pred: () => boolean, view: () => View): View {
  return ForEach({ items: () => (pred() ? [{ id: key }] : []), key: (x) => x.id }, view);
}

/** Board 1's halo is 3pt of soft colour round the dot: 13pt round a 7pt dot. */
export const haloSize = (dot: number): number => dot + 6;

/** The one status decision behind board 1's halo: working or needs only, everything else "clear". */
export type HaloStatus = "working" | "needs_input";

/** Which status, if any, gets the halo. Each sidebar maps this to its own halo colour. */
export function haloStatus(status: string | undefined): HaloStatus | null {
  return status === "working" || status === "needs_input" ? status : null;
}

/**
 * The halo colour for `status` from the caller's own halo tokens (one entry
 * per HaloStatus), or "clear" for every other status. The one place both
 * sidebars turn the halo decision into an actual colour, so a third haloed
 * status or a changed fallback only needs changing here.
 */
export function haloColor(status: string | undefined, colors: Record<HaloStatus, string>): string {
  const hs = haloStatus(status);
  return hs ? colors[hs] : "clear";
}

/**
 * A dot over board 1's soft halo. The frame is always the halo's size, so
 * dots with and without a halo ("clear") line up down a list.
 */
export function haloDot(dot: View, halo: Reactive<string>, size: number): View {
  const outer = haloSize(size);
  return ZStack({}, [Circle({ size: outer }).fill(halo), dot]).frame({ width: outer, height: outer });
}

/**
 * A project's badge: its icon on a rounded square of its colour, the glyph
 * inked light or dark for contrast. `p` is a getter so a caller whose row
 * outlives its project can follow it. One look on both sides (issue #82).
 */
export function projectBadge(p: () => Project, size: number, font: number, radius = 5): View {
  return ZStack({}, [
    RoundedRectangle({ cornerRadius: radius }).fill(() => p().color),
    Image(() => p().icon)
      .font(font)
      .weight("semibold")
      .color(() => glyphColor(p().color, P.text)),
  ]).frame({ width: size, height: size });
}

/**
 * Edge as a filled ring: the edge colour fills an outer rounded box and the
 * face sits inset by the edge width. A borderWidth stroke is clipped by the
 * corner radius and thins out round every corner. `hug` keeps the face at
 * its content width (chips, buttons) instead of filling the row.
 */
export function ring(
  view: View,
  face: Reactive<string>,
  edge: Reactive<string>,
  width: Reactive<number>,
  radius: number,
  hug = false,
): View {
  const wv = typeof width === "function" ? width : () => width;
  const inner = view.background(face).cornerRadius(() => radius - wv());
  return VStack({ spacing: 0, alignment: "leading" }, [
    hug ? inner : inner.frame({ maxWidth: "infinity", alignment: "leading" }),
  ])
    .padding(wv)
    .background(edge)
    .cornerRadius(radius);
}

/** The size of the small text both sides trail a row with: times, branches, ports, chips. */
export const META_FONT = 11;

/**
 * Trailing metadata (an age, a PR number): monospaced so digits hold still,
 * and it never wraps: it keeps its width and the title truncates instead.
 */
export function meta(fn: () => string, color: Reactive<string> = P.tertiary): View {
  return Text(fn).font(META_FONT).monospaced().color(color).lineLimit(1).layoutPriority(2);
}

/** A branch name: cut in the middle, so both its start and its end still show. */
export function branchText(fn: () => string, color: Reactive<string>, weight: Weight = "regular"): View {
  return Text(fn).font(META_FONT).weight(weight).color(color).lineLimit(1).truncation("middle");
}

/** A chip's frame round `body`: its face and edge, hugging the content. */
export function chipFrame(body: View, colors: () => ChipColors): View {
  return ring(
    body.paddingHorizontal(6).paddingVertical(1),
    () => colors().bg,
    () => colors().edge,
    1,
    6,
    true,
  );
}

/** A chip's words: medium weight, one line; `mono` for ports, so digits hold still. */
export function chipText(label: () => string, fg: () => string, mono = false): View {
  const sized = Text(label).font(META_FONT);
  // Monospaced straight after the font, as meta() does.
  return (mono ? sized.monospaced() : sized).weight("medium").lineLimit(1).truncation("tail").color(fg);
}

/** The one chip both sidebars build for a PR's state and a port: words in a hugging frame. */
export function chip(label: () => string, colors: () => ChipColors, mono = false): View {
  return chipFrame(
    chipText(label, () => colors().fg, mono),
    colors,
  );
}

/** The unread count, grey on both sides so clay only ever means needs you; nothing at zero. */
export function unreadBadge(n: () => number): View {
  const has = () => n() > 0;
  return Text(() => (has() ? String(n()) : ""))
    .font(10)
    .bold()
    .color(P.onBadge)
    .paddingHorizontal(() => (has() ? 5 : 0))
    .paddingVertical(() => (has() ? 1 : 0))
    .background(() => (has() ? P.badge : "clear"))
    .cornerRadius(7);
}

// Headings come in two styles on both sides (issue #82): a lane or project
// header's name, and a section's small capitals.

/** A lane or project header's name: it wins the row's width and truncates rather than wrapping. */
export function laneTitle(name: string, color: string, weight: Weight = "semibold"): View {
  return Text(name).font(12.5).weight(weight).color(color).lineLimit(1).truncation("tail").layoutPriority(1);
}

/** A section heading in tracked capitals: "NEEDS YOU", "WORKING", "CHECKS". One line, since each hair space could break it. */
export function sectionTitle(label: string, color: string): View {
  return Text(tracked(label)).font(10.5).weight("semibold").color(color).lineLimit(1);
}
