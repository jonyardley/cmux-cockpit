// Rows for the Pull requests and Made here panels.
// A capped list ends in a quiet "+N more" row (issue #80) that opens it (#109).

import type { Last } from "../../shared/list.ts";
import { meta, openIfUrl, when } from "../../shared/ui.ts";
import {
  isPeeking,
  type MadeEntry,
  madeAge,
  madeIcon,
  madeTitleColor,
  type PrEntry,
  prFromText,
  togglePeek,
} from "../model.ts";
import { T } from "../theme.ts";
import { glyph, prChip, ruled } from "./parts.ts";
import { peekCard } from "./peek.ts";

/** The quiet row a capped list ends in: "+12 more", or "Show less" once
 * open. Tapping it opens or folds the card. */
export function footRow(text: () => string, onTap: () => void): View {
  const row = HStack({ spacing: 6 }, [Text(text).font(11.5).color(T.tertiary).lineLimit(1), Spacer()])
    .paddingHorizontal(12)
    .paddingVertical(8)
    .hoverBackground(T.hover)
    .frame({ maxWidth: "infinity", alignment: "leading" })
    .onTap(onTap);
  return ruled(row, () => true);
}

// The row's quiet way out to GitHub, its own tap target beside the chip.
function githubArrow(url: () => string | undefined): View {
  return Text("↗")
    .font(11)
    .weight("semibold")
    .color(T.tertiary)
    .paddingHorizontal(4)
    .paddingVertical(2)
    .hoverBackground(T.hover)
    .cornerRadius(4)
    .onTap(() => openIfUrl(url()));
}

/** A PR row: tap opens its peek card under it; the arrow opens GitHub. */
export function prRow(e: () => Last<PrEntry>): View {
  const top = HStack({ spacing: 10 }, [
    Text(() => "#" + (e().pr.number ?? ""))
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
    prChip(e).layoutPriority(2),
  ]);
  // The tappable part stops short of the arrow, so a tap on the arrow can
  // only open GitHub and never also toggle the peek card.
  const tappable = VStack({ spacing: 2, alignment: "leading" }, [
    top,
    when(
      "pr-from",
      () => !!prFromText(e()),
      () =>
        meta(() => prFromText(e()))
          .lineLimit(1)
          .truncation("middle"),
    ),
  ])
    .paddingLeading(12)
    .paddingTrailing(4)
    .paddingVertical(10)
    .hoverBackground(T.hover)
    .frame({ maxWidth: "infinity", alignment: "leading" })
    .onTap(() => togglePeek(e()));
  // Top-aligned and padded down to the first line, so the arrow stays
  // beside the chip when the from line shows under it.
  const arrow = VStack({ spacing: 0 }, [githubArrow(() => e().pr.url)])
    .paddingTop(10)
    .paddingTrailing(8);
  const row = HStack({ spacing: 6, alignment: "top" }, [tappable, arrow])
    .background(() => (isPeeking(e()) ? T.hover : "clear"))
    .frame({ maxWidth: "infinity", alignment: "leading" });
  const withPeek = VStack({ spacing: 0, alignment: "leading" }, [
    row,
    when(
      "pr-peek",
      () => isPeeking(e()),
      () => peekCard(e),
    ),
  ]).frame({ maxWidth: "infinity", alignment: "leading" });
  return ruled(withPeek, () => e().last);
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
