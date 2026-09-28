// A PR's peek card, opened by tapping its row: the title and state, the chat
// that opened it, the paragraph where that chat first told Jon about it, its
// checks, and buttons to go back to the chat or out to GitHub.

import { dimmedColors, prChipColors } from "../../shared/pr-colors.ts";
import { chip, openIfUrl, ring, when } from "../../shared/ui.ts";
import {
  canShowInChat,
  type PrEntry,
  peekChecks,
  peekQuote,
  peekTitle,
  peekWaiting,
  prChipHealth,
  prChipText,
  prDim,
  prSource,
  showInChat,
} from "../model.ts";
import { T } from "../theme.ts";

function button(label: string, face: string, hover: string, fg: string, onTap: () => void): View {
  return Text(label)
    .font(12)
    .weight("medium")
    .color(fg)
    .lineLimit(1)
    .paddingHorizontal(10)
    .paddingVertical(4)
    .background(face)
    .hoverBackground(hover)
    .cornerRadius(7)
    .onTap(onTap);
}

// The quote with a bar down its leading edge, as the chat's highlight has.
function quote(e: () => PrEntry): View {
  return HStack({ spacing: 8 }, [
    Rectangle().fill(T.quoteBar).frame({ width: 3, maxHeight: "infinity" }),
    Text(() => peekQuote(e()))
      .font(12)
      .color(T.text)
      .lineLimit(8)
      .paddingVertical(6)
      .layoutPriority(1),
    Spacer({ minLength: 0 }),
  ])
    .background(T.quote)
    .cornerRadius(6)
    .frame({ maxWidth: "infinity", alignment: "leading" });
}

const faint = (text: () => string): View => Text(text).font(11).color(T.secondary).lineLimit(2);

export function peekCard(e: () => PrEntry): View {
  const colors = () => {
    const h = prChipHealth(e());
    return dimmedColors(prChipColors(h.health, e().pr.status, h.draft), prDim(e()));
  };
  const body = VStack({ spacing: 8, alignment: "leading" }, [
    HStack({ spacing: 8, alignment: "top" }, [
      Text(() => peekTitle(e()))
        .font(12.5)
        .weight("semibold")
        .color(T.text)
        .lineLimit(3)
        .layoutPriority(1),
      Spacer({ minLength: 4 }),
      chip(() => prChipText(e()), colors),
    ]),
    when(
      "peek-source",
      () => !!prSource(e()),
      () => faint(() => prSource(e())),
    ),
    when(
      "peek-quote",
      () => !!peekQuote(e()),
      () => quote(e),
    ),
    when(
      "peek-waiting",
      () => !!peekWaiting(e()),
      () => faint(() => peekWaiting(e())),
    ),
    when(
      "peek-checks",
      () => !!peekChecks(e()),
      () => faint(() => "Checks: " + peekChecks(e())),
    ),
    HStack({ spacing: 8 }, [
      when(
        "peek-show",
        () => canShowInChat(e()),
        () => button("Show in chat", T.inkButton, T.inkButtonHover, T.onInk, () => showInChat(e())),
      ),
      button("Open on GitHub ↗", T.quietButton, T.quietButtonHover, T.text, () => openIfUrl(e().pr.url)),
      Spacer(),
    ]),
  ]).padding(10);
  // Outer margins on a wrapper, never on the ring itself.
  return VStack({ spacing: 0, alignment: "leading" }, [ring(body, T.panel, T.peekEdge, 1, 10)])
    .paddingHorizontal(10)
    .paddingBottom(10)
    .frame({ maxWidth: "infinity", alignment: "leading" });
}
