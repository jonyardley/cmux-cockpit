// Workspace cards at the three lane densities (full, compact, row), plus the
// one row shape the Projects view uses.

import { prSummary } from "../../shared/prs.ts";
import { displayTitle } from "../../shared/titles.ts";
import { meta, ring, unreadBadge, when } from "../../shared/ui.ts";
import { hasChipsRow } from "../chips.ts";
import type { Lane } from "../lanes.ts";
import { cardDensity, showsLeftOff } from "../model.ts";
import { drag, isSelected, selectWorkspace } from "../state.ts";
import {
  ageOf,
  cardDetail,
  compactPrText,
  detailColor,
  helperText,
  leftOffText,
  moveOf,
  progressFraction,
  prTextColor,
} from "../status.ts";
import { C } from "../theme.ts";
import {
  cardChrome,
  cardMenu,
  chipsRow,
  glyph,
  statusDot,
  statusLabel,
  titleRow,
  toReviewAction,
  type WsAccessor,
} from "./parts.ts";

// Along the bottom while the workspace sends a progress value (issue #47).
function progressBar(w: WsAccessor, key: string): View {
  return when(
    key,
    () => progressFraction(w()) !== null,
    () =>
      ProgressView()
        .value(() => progressFraction(w()) ?? 0)
        .frame({ maxWidth: "infinity" }),
  );
}

// The live helper count after the status, in a quiet colour. Behind a
// when(), so with no helpers it takes no slot in the status line's spacing.
function helpers(w: WsAccessor, size: number): View {
  return when(
    "helpers",
    () => !!helperText(w()),
    () =>
      Text(() => helperText(w()))
        .font(size)
        .color(C.tertiary)
        .lineLimit(1),
  ).layoutPriority(2);
}

// The latest message under the status, in the full card's detail size, over
// `lines` lines, `indent` in from the card's edge; faded on the selected
// card (detailColor), never hidden, so a tap never changes a card's height.
function detailLine(w: WsAccessor, key: string, lines: number, indent = 0): View {
  // Read by the when() and its Text, so the message is worked out once per change.
  const detail = computed(() => cardDetail(w()));
  return when(
    key,
    () => !!detail(),
    () =>
      Text(detail)
        .font(12)
        .color(() => detailColor(isSelected(w())))
        .lineLimit(lines)
        .truncation("tail")
        .paddingLeading(indent)
        .frame({ maxWidth: "infinity", alignment: "leading" }),
  );
}

// Your last prompt, above the agent's latest message, on cards in lanes
// you come back to after a while (model.ts's showsLeftOff). Tertiary ink,
// so the agent's words stay the stronger line, and faint on the selected
// card, as its message is, since the agents panel shows both in full.
function leftOffLine(w: WsAccessor, key: string, indent = 0): View {
  const text = computed(() => (showsLeftOff(w()) ? leftOffText(w()) : ""));
  return when(
    key,
    () => !!text(),
    () =>
      Text(text)
        .font(12)
        .color(() => (isSelected(w()) ? C.faint : C.tertiary))
        .lineLimit(1)
        .truncation("tail")
        .paddingLeading(indent)
        .frame({ maxWidth: "infinity", alignment: "leading" }),
  );
}

function fullCard(w: WsAccessor, key: string): View {
  const body = HStack({ spacing: 10, alignment: "top" }, [
    glyph(w, 26, 8, 12),
    VStack({ alignment: "leading", spacing: 4 }, [
      titleRow(w, 13.5),
      // No PR words here, Ready or not: the chips row below carries its chip (issue #79).
      HStack({ spacing: 6 }, [statusDot(w, 7), statusLabel(w, 12, "medium"), helpers(w, 12)])
        // Left-aligned by the frame, not a Spacer, as the chips row is.
        .frame({ maxWidth: "infinity", alignment: "leading" }),
      // The PR and branch under the status, then the message.
      chipsRow(w, true, "still"),
      detailLine(w, "detail", 2),
      progressBar(w, "full-progress"),
    ])
      .frame({ maxWidth: "infinity", alignment: "leading" })
      .layoutPriority(1),
  ])
    .paddingLeading(10)
    .paddingTrailing(12)
    .paddingVertical(11);
  return cardChrome(body, w, key, 12);
}

// Options board "Compact": the PR rides in the status line as text, and
// the latest message takes one line under it.
export function compactCard(w: WsAccessor, key: string): View {
  const pr = computed(() => prSummary(w()));
  const body = HStack({ spacing: 9 }, [
    glyph(w, 22, 7, 11),
    VStack({ alignment: "leading", spacing: 3 }, [
      titleRow(w, 13),
      HStack({ spacing: 6 }, [
        statusDot(w, 6),
        statusLabel(w, 11.5, "regular"),
        helpers(w, 11.5),
        // The one part that gives way: the status and helpers hold priority
        // 2, so on a narrow card the PR text is cut and the status and time show.
        // Behind a when(), so a card with no PR has no slot and no gap after the status.
        when(
          "compact-pr",
          () => !!pr(),
          () =>
            Text(() => compactPrText(pr()))
              .font(11.5)
              .color(() => prTextColor(pr(), C.secondary))
              .lineLimit(1)
              .truncation("tail"),
        ),
        // Left-aligned by the frame, not a Spacer, as on the full card.
      ]).frame({ maxWidth: "infinity", alignment: "leading" }),
      leftOffLine(w, "compact-left-off"),
      detailLine(w, "compact-detail", 1),
      // Compact cards have no chips row, so a Ready one in Background takes
      // the action on a line of its own.
      toReviewAction(w),
      progressBar(w, "compact-progress"),
    ])
      .frame({ maxWidth: "infinity", alignment: "leading" })
      .layoutPriority(1),
  ])
    .paddingLeading(10)
    .paddingTrailing(12)
    .paddingVertical(11);
  return cardChrome(body, w, key, 12);
}

// "Row" density (Options board, .plain): dot, title, meta, then one line of
// the latest message under the title; selection is the white hairline pill,
// a drag lifts it in ink.
function denseRow(w: WsAccessor, key: string): View {
  // The number alone, so a row never widens; the words live on the cards.
  const pr = computed(() => prSummary(w()));
  const head = HStack({ spacing: 6 }, [
    statusDot(w, 7),
    Text(() => displayTitle(w()))
      .font(12.5)
      .weight(() => (isSelected(w()) ? "medium" : "regular"))
      .color(C.text)
      .lineLimit(1)
      .truncation("middle")
      .layoutPriority(1),
    // The PR's own title after the session name, faint (issue #73). At the
    // lowest priority, so it is what gets cut and the dot, PR and time show.
    when(
      "row-pr-title",
      () => !!pr()?.title,
      () =>
        Text(() => "· " + (pr()?.title ?? ""))
          .font(12.5)
          .color(C.faint)
          .lineLimit(1)
          .truncation("tail"),
    ),
    Spacer({ minLength: 4 }),
    unreadBadge(() => w()?.unread ?? 0),
    when(
      "row-pr",
      () => !!pr(),
      () =>
        meta(
          () => pr()?.tag ?? "",
          () => prTextColor(pr(), C.metaText),
        ),
    )
      // On the when() result: the priority inside meta() does not reach this HStack.
      .layoutPriority(2),
    meta(() => ageOf(w()), C.metaText),
  ]);
  const body = VStack({ alignment: "leading", spacing: 2 }, [
    head,
    // Under the title: past the 7pt dot and the 6pt gap after it.
    leftOffLine(w, "row-left-off", 13),
    detailLine(w, "row-detail", 1, 13),
  ])
    .paddingLeading(25)
    .paddingTrailing(12)
    .paddingVertical(5);
  const dragged = () => drag()?.id === key;
  const on = () => dragged() || isSelected(w());
  return ring(
    body,
    () => (on() ? C.card : "clear"),
    () => (dragged() ? C.select : on() ? C.cardEdge : "clear"),
    () => (dragged() ? 1.5 : 1),
    9,
    // The hover replaces the face: the wash on a clear row, a whole face on a lit one.
    { hover: { face: () => (on() ? C.cardHover : C.hover) } },
  )
    .frame({ maxWidth: "infinity" })
    .onTap(() => selectWorkspace(w()?.id))
    .contextMenu(cardMenu(w));
}

/**
 * The card at the density its lane uses (All view). A card keeps its row
 * when it changes lane, and only the inside is rebuilt, when cardDensity
 * changes: cmux 0.64.25 keeps drawing a dropped row that is swapped for a
 * new one, so a card rebuilt on the drop left its parts on screen.
 */
export function cardFor(w: WsAccessor, key: string): View {
  const at = (d: Lane["density"]) => () => cardDensity(w()) === d;
  return VStack({ spacing: 0 }, [
    when("card-full", at("full"), () => fullCard(w, key)),
    when("card-compact", at("compact"), () => compactCard(w, key)),
    when("card-row", at("row"), () => denseRow(w, key)),
  ]).frame({ maxWidth: "infinity" });
}

// What a waiting chat wants ("Run /clear now."), on the Projects row, which
// otherwise shows no message. Behind a when(), so a row with no move has no
// line and no gap for it.
function moveLine(w: WsAccessor): View {
  const text = computed(() => moveOf(w())?.text ?? "");
  return when(
    "project-move",
    () => !!text(),
    () =>
      Text(text)
        .font(12)
        .color(() => detailColor(isSelected(w())))
        .lineLimit(2)
        .truncation("tail")
        .paddingTop(3)
        .frame({ maxWidth: "infinity", alignment: "leading" }),
  );
}

// Projects view (board 2, #11): one row shape for every session. No glyph,
// since the project header carries it; title and age, status dot and label
// without the message (a waiting chat's move aside), then the branch and PR chips. Selection is the card's
// ink ring.
export function projectRow(w: WsAccessor, key: string): View {
  // Spacing lives on the rows, so a row with no chips has no gap below it.
  const body = VStack({ alignment: "leading", spacing: 0 }, [
    titleRow(w, 12.5),
    HStack({ spacing: 6 }, [statusDot(w, 7), statusLabel(w, 12, "medium"), Spacer({ minLength: 0 })])
      .frame({ maxWidth: "infinity" })
      .paddingTop(2),
    moveLine(w),
    chipsRow(w, true).paddingTop(() => (hasChipsRow(w(), true) ? 3 : 0)),
  ])
    .frame({ maxWidth: "infinity", alignment: "leading" })
    .paddingHorizontal(10)
    .paddingVertical(8);
  return cardChrome(body, w, key, 9);
}
