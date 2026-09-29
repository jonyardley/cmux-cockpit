// Rows for the Pull requests and Made here panels.
// A capped list ends in a quiet "+N more" row (issue #80) that opens it (#109).

import type { Last } from "../../shared/list.ts";
import { meta, openIfUrl, when } from "../../shared/ui.ts";
import { goToPr, type MadeEntry, madeAge, madeIcon, madeTitleColor, type PrEntry, prFromText } from "../model.ts";
import { T } from "../theme.ts";
import { glyph, prChip, ruled } from "./parts.ts";

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

/** A PR row: tap goes back to the chat that opened it (GitHub once that
 * chat has gone); the state pill opens GitHub. */
export function prRow(e: () => Last<PrEntry>): View {
  // The pill sits in the title's line, so the stack centres it on the
  // title whether or not the from line shows under it. Stale rides inside
  // the chip: an empty sibling Text would still cost spacing.
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
    prChip(e).layoutPriority(2),
  ]);
  // The whole row lights and taps, as the other rows do. The pill's own
  // tap sits inside it and wins, as a chip's does on a cockpit card, so a
  // tap on the pill opens GitHub and never also jumps to the chat.
  const row = VStack({ spacing: 2, alignment: "leading" }, [
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
    .paddingHorizontal(12)
    .paddingVertical(10)
    .hoverBackground(T.hover)
    .frame({ maxWidth: "infinity", alignment: "leading" })
    .onTap(() => goToPr(e()));
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
