// Rows for the Pull requests and Made here panels.
// A capped list ends in a quiet "+N more" row (issue #80) that opens it (#109).

import type { Last } from "../../shared/list.ts";
import { META_FONT, meta, openIfUrl, when } from "../../shared/ui.ts";
import { type MadeEntry, madeAge, madeTitleColor, type PrEntry, prNumberText } from "../model.ts";
import { T } from "../theme.ts";
import { glyph, prChip, ruled, withChatMenu } from "./parts.ts";

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

/** A PR row: its project's tile, the title and its state chip, then a faint
 * line with the number and the session it belongs to. A tap anywhere on it,
 * the chip included, opens the PR on GitHub; a right-click offers Open chat
 * while it has a session. */
export function prRow(e: () => Last<PrEntry>): View {
  // The tile and chip centre on the title's line, whether or not the session shows under it.
  const top = () =>
    HStack({ spacing: 10 }, [
      glyph(() => e().project, 16),
      Text(() => e().title)
        .font(12.5)
        .color(T.text)
        .lineLimit(1)
        .truncation("tail")
        .layoutPriority(1),
      Spacer({ minLength: 4 }),
      prChip(e).layoutPriority(2),
    ]);
  // The number, then the session's dot and name, the dot following the
  // number's width. Indented past the tile, so it sits under the title.
  // Each part is left out rather than drawn empty, since an empty Text still costs spacing.
  const hollow = () => e().session?.hollow ?? false;
  const sub = () =>
    HStack({ spacing: 5 }, [
      when(
        "pr-number",
        () => !!prNumberText(e()),
        () => meta(() => prNumberText(e())),
      ),
      when(
        "pr-session",
        () => !!e().session,
        () =>
          HStack({ spacing: 5 }, [
            Circle({ size: 6 })
              .fill(() => (hollow() ? "clear" : (e().session?.dot ?? "clear")))
              .stroke(() => (hollow() ? T.grey : "clear"))
              .strokeWidth(1.5),
            Text(() => e().session?.name ?? "")
              .font(META_FONT)
              .color(T.tertiary)
              .lineLimit(1)
              .truncation("tail"),
          ]),
      ),
      Spacer(),
    ]).paddingLeading(26);
  const row = () =>
    VStack({ spacing: 2, alignment: "leading" }, [top(), sub()])
      .paddingHorizontal(12)
      .paddingVertical(8)
      .hoverBackground(T.hover)
      .frame({ maxWidth: "infinity", alignment: "leading" })
      .onTap(() => openIfUrl(e().pr.url));
  return ruled(
    withChatMenu(row, () => e().session?.chat),
    () => e().last,
  );
}

/** One page or doc an agent published: its project's tile (grey when the
 * workspace that made it is unknown), title and age. Tap opens it on claude.ai;
 * a right-click offers Open chat while that workspace is open. */
export function madeRow(e: () => Last<MadeEntry>): View {
  const row = () =>
    HStack({ spacing: 10 }, [
      glyph(() => e().project),
      Text(() => e().title)
        .font(12.5)
        .color(() => madeTitleColor(e()))
        .lineLimit(1)
        .truncation("tail")
        .layoutPriority(1),
      Spacer({ minLength: 4 }),
      meta(() => madeAge(e())),
    ])
      .paddingHorizontal(12)
      .paddingVertical(9)
      .hoverBackground(T.hover)
      .frame({ maxWidth: "infinity", alignment: "leading" })
      .onTap(() => openIfUrl(e().url));
  return ruled(
    withChatMenu(row, () => e().chat),
    () => e().last,
  );
}
