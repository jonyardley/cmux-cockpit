// Rows for the Pull requests and Made here panels.
// A capped list ends in a quiet "+N more" row (issue #80) that opens it (#109).

import type { Last } from "../../shared/list.ts";
import { prChipColors } from "../../shared/pr-colors.ts";
import { chip, meta } from "../../shared/ui.ts";
import {
  type MadeEntry,
  madeAge,
  madeIcon,
  madeTitleColor,
  type PrEntry,
  prChipHealth,
  prChipText,
  prDim,
} from "../model.ts";
import { STALE_OPACITY, T } from "../theme.ts";
import { glyph, openIfUrl, ruled } from "./parts.ts";

/** The quiet row a capped list ends in: "+12 more", or "Show less" once
 * open. Tapping it opens or folds the card. */
export function footRow(text: () => string, onTap: () => void): View {
  const row = HStack({ spacing: 6 }, [Text(text).font(11.5).color(T.tertiary).lineLimit(1), Spacer()])
    .paddingHorizontal(12)
    .paddingVertical(8)
    .frame({ maxWidth: "infinity", alignment: "leading" })
    .onTap(onTap);
  return ruled(row, () => true);
}

export function prRow(e: () => Last<PrEntry>): View {
  const p = () => e().pr;
  const colors = () => {
    const h = prChipHealth(e());
    return prChipColors(h.health, p().status, h.draft);
  };
  const row = HStack({ spacing: 10 }, [
    Text(() => "#" + (p().number ?? ""))
      .font(12)
      .monospaced()
      .color(T.secondary)
      .lineLimit(1)
      .layoutPriority(2),
    Text(() => e().title)
      .font(12.5)
      .color(T.text)
      .lineLimit(1)
      .truncation("tail")
      .layoutPriority(1),
    Spacer({ minLength: 4 }),
    // Stale rides inside the chip: an empty sibling Text would still cost
    // its HStack spacing and squeeze the title.
    chip(() => prChipText(e()), colors)
      .opacity(() => (prDim(e()) ? STALE_OPACITY : 1))
      .layoutPriority(2),
  ])
    .paddingHorizontal(12)
    .paddingVertical(10)
    .hoverBackground(T.hover)
    .frame({ maxWidth: "infinity", alignment: "leading" })
    .onTap(() => openIfUrl(p().url));
  return ruled(row, () => e().last);
}

/** One page or doc an agent published: tap opens it on claude.ai. */
export function madeRow(e: () => Last<MadeEntry>): View {
  const row = HStack({ spacing: 10 }, [
    Image(() => madeIcon(e()))
      .font(11)
      .color(T.tertiary)
      .frame({ width: 16 }),
    Text(() => e().title)
      .font(12.5)
      .color(() => madeTitleColor(e()))
      .lineLimit(1)
      .truncation("tail")
      .layoutPriority(1),
    Spacer({ minLength: 4 }),
    meta(() => madeAge(e())),
    glyph(() => e().project),
  ])
    .paddingHorizontal(12)
    .paddingVertical(10)
    .hoverBackground(T.hover)
    .frame({ maxWidth: "infinity", alignment: "leading" })
    .onTap(() => openIfUrl(e().url));
  return ruled(row, () => e().last);
}
