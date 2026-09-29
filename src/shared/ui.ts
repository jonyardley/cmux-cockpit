// View helpers shared by both sidebars.

import { glyphColor } from "./contrast.ts";
import { P } from "./palette.ts";
import type { ChipColors } from "./pr-colors.ts";
import type { Project } from "./projects.ts";
import { hoverFace, shade } from "./shade.ts";
import { tracked } from "./text.ts";

/**
 * Shows `view` only while `pred()` is true (a ForEach over zero or one item).
 * A layoutPriority set inside `view` does not reach the parent stack, so set it
 * on the `when()` result.
 */
export function when(key: string, pred: () => boolean, view: () => View): View {
  return ForEach({ items: () => (pred() ? [{ id: key }] : []), key: (x) => x.id }, view);
}

/**
 * A ForEach whose rows fade in and out and slide to a new place: cmux gives
 * that motion only to a Reorderable, so this is one with every row pinned
 * and its drag hooks doing nothing. A ForEach snaps. Spacing is required:
 * a Reorderable is its own stack, so it does not take its parent's.
 */
export function motionList<T>(
  opts: Omit<ReorderableOptions<T>, "onMove" | "onDragChange"> & { spacing: number },
  render: (item: () => T) => View,
): View {
  return Reorderable({ ...opts, onMove: () => {}, onDragChange: () => {} }, (item) => render(item).fixed());
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
 * its content width (chips, buttons) instead of filling the row. Without
 * it the full-width frame comes before the face, so the face reaches the
 * edge whether or not the content fills its own width (issue #93).
 */
export function ring(
  view: View,
  face: Reactive<string>,
  edge: Reactive<string>,
  width: Reactive<number>,
  radius: number,
  { hug = false, hover }: RingOptions = {},
): View {
  const wv = typeof width === "function" ? width : () => width;
  const sized = hug ? view : view.frame({ maxWidth: "infinity", alignment: "leading" });
  const inner = sized.background(face).cornerRadius(() => radius - wv());
  const outer = VStack({ spacing: 0, alignment: "leading" }, [hover ? inner.hoverBackground(hover.face) : inner])
    .padding(wv)
    .background(edge)
    .cornerRadius(radius);
  return hover?.edge ? outer.hoverBackground(hover.edge) : outer;
}

interface RingOptions {
  hug?: boolean;
  hover?: Hover;
}

/**
 * A ring's look under the pointer. cmux's hoverBackground replaces the
 * node's background instead of washing over it, so a face over an opaque
 * one is a whole colour (shade.ts). `edge` darkens the ring as well: the
 * outer box is the edge, so its hover colour only shows round the face.
 */
export interface Hover {
  face: Reactive<string>;
  edge?: Reactive<string>;
}

// How far a tap target inside a card steps toward ink under the pointer.
const FACE_STEP = 0.07;
const EDGE_STEP = 0.35;

/**
 * A chip's hover: its own face and edge, each a step darker; a faint face
 * (a hue with an alpha pair) also a step more opaque, or its hover would
 * barely show (hoverFace). Worked out once per colour change. With `live`
 * false (nothing to open) the chip keeps its resting look.
 */
export function chipHover(colors: () => ChipColors, live: () => boolean = () => true): Hover {
  const lit = computed(() => {
    const c = colors();
    if (!live()) return { face: c.bg, edge: c.edge };
    return { face: hoverFace(c.bg, FACE_STEP), edge: shade(c.edge, EDGE_STEP) };
  });
  return { face: () => lit().face, edge: () => lit().edge };
}

/** Opens `url` in the browser, when there is one. */
export function openIfUrl(url: string | undefined): void {
  if (url) openURL(url);
}

/**
 * The "opens in the browser" mark: shown only while its nearest ancestor
 * with a hoverBackground is under the pointer, and never while `live` is
 * false. The renderer hides it by opacity, so it keeps its slot at rest:
 * give it a place where that blank slot is already free space, or swap it
 * for a glyph with hideOnHover.
 */
export function outMark(color: Reactive<string>, live: () => boolean = () => true): View {
  return Text("↗")
    .font(9)
    .weight("semibold")
    .color(color)
    .lineLimit(1)
    .layoutPriority(2)
    .opacity(() => (live() ? 1 : 0))
    .showOnHover();
}

// A link box's inset: its 1pt edge plus the chip's 6pt padding.
const LINK_INSET = 7;

/**
 * A line of text that opens `url`, inside a card: at rest it looks like
 * the text around it; under the pointer it takes a chip's box and shows ↗
 * after it. The box's padding matches a chip's, and a negative stack
 * spacing pulls it back by that inset, so at rest the text starts where
 * the lines above it do. With no url it keeps its resting look.
 */
export function linkBox(children: View[], color: Reactive<string>, url: () => string | undefined): View {
  const live = () => !!url();
  const body = HStack({ spacing: 6 }, [...children, outMark(color, live)]).paddingHorizontal(LINK_INSET - 1);
  const hover = {
    face: () => (live() ? P.linkHover : "clear"),
    edge: () => (live() ? P.linkEdge : "clear"),
  };
  const box = ring(body, "clear", "clear", 1, 6, { hug: true, hover }).onTap(() => openIfUrl(url()));
  // A zero-width lead: the negative spacing after it puts the box LINK_INSET left of the column.
  return HStack({ spacing: -LINK_INSET }, [Rectangle().fill("clear").frame({ width: 0, height: 0 }), box]);
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
export function chipFrame(body: View, colors: () => ChipColors, hover?: Hover): View {
  return ring(
    body.paddingHorizontal(6).paddingVertical(1),
    () => colors().bg,
    () => colors().edge,
    1,
    6,
    { hug: true, ...(hover ? { hover } : {}) },
  );
}

/**
 * A chip's words: medium weight unless told otherwise, one line; `mono`
 * for ports, so digits hold still.
 */
export function chipText(label: () => string, fg: () => string, mono = false, weight: Weight = "medium"): View {
  const sized = Text(label).font(META_FONT);
  // Monospaced straight after the font, as meta() does.
  return (mono ? sized.monospaced() : sized).weight(weight).lineLimit(1).truncation("tail").color(fg);
}

/** A chip that opens `url`: under the pointer its face and edge each step darker (chipHover). */
export function tapChip(
  label: () => string,
  colors: () => ChipColors,
  url: () => string | undefined,
  mono = false,
): View {
  return chipFrame(
    chipText(label, () => colors().fg, mono),
    colors,
    chipHover(colors, () => !!url()),
  ).onTap(() => openIfUrl(url()));
}

/** The badge's figure: the count, or nothing at zero (or a bad count), so no empty pill shows. */
export const badgeLabel = (n: number): string => (n > 0 ? String(n) : "");

/** The unread count, grey on both sides so clay only ever means needs you; nothing at zero. */
export function unreadBadge(n: () => number): View {
  const has = () => n() > 0;
  return Text(() => badgeLabel(n()))
    .font(10)
    .bold()
    .color(P.onBadge)
    .paddingHorizontal(() => (has() ? 5 : 0))
    .paddingVertical(() => (has() ? 1 : 0))
    .background(() => (has() ? P.badge : "clear"))
    .cornerRadius(7);
}

/** A count pill's face and words. */
export interface PillColors {
  bg: string;
  fg: string;
}

/** The count pill with nothing urgent behind it: grey. */
export const QUIET_PILL: PillColors = { bg: P.countBg, fg: P.metaText };

/**
 * A header's count pill, one look on both sides. An empty count shows no
 * pill at all: the agents panel passes "" for a section header with no
 * count. Both sides show a 0 as a pill. `colors` tints it by the most
 * urgent session behind the count; grey without it.
 */
export function countPill(count: () => string, colors: () => PillColors = () => QUIET_PILL): View {
  const has = () => count() !== "";
  return Text(count)
    .font(11)
    .weight("medium")
    .color(() => colors().fg)
    .lineLimit(1)
    .paddingHorizontal(() => (has() ? 7 : 0))
    .paddingVertical(1)
    .background(() => (has() ? colors().bg : "clear"))
    .cornerRadius(10);
}

// Headings come in two styles on both sides (issue #82): a lane or project
// header's name, and a section's small capitals.

/** A lane or project header's name: it wins the row's width and truncates rather than wrapping. */
export function laneTitle(name: string, color: string, weight: Weight = "semibold"): View {
  return Text(name).font(12.5).weight(weight).color(color).lineLimit(1).truncation("tail").layoutPriority(1);
}

/** A section heading in tracked capitals: "NEEDS YOU", "HELPERS", "CHECKS". One line, since each hair space could break it. */
export function sectionTitle(label: Reactive<string>, color: string): View {
  const text = typeof label === "function" ? () => tracked(label()) : tracked(label);
  return Text(text).font(10.5).weight("semibold").color(color).lineLimit(1);
}
