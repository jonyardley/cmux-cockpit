// Workspace cards at the three lane densities (full, compact, row), plus the
// one row shape the Projects view uses.

import { prSummary } from "../../shared/prs.ts";
import { displayTitle } from "../../shared/titles.ts";
import { meta, ring, when } from "../../shared/ui.ts";
import { type LaneKey, laneByKey } from "../lanes.ts";
import { hasChipsRow } from "../model.ts";
import { drag, isSelected, selectWorkspace } from "../state.ts";
import { ageOf, cardDetail, compactPrText, helperText, progressFraction, prTextColor } from "../status.ts";
import { C } from "../theme.ts";
import {
  cardChrome,
  cardMenu,
  cardUnread,
  chipsRow,
  glyph,
  prLine,
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

function fullCard(w: WsAccessor, key: string): View {
  // Read by the when() and its Text, so the message is worked out once per change.
  const detail = computed(() => cardDetail(w()));
  const body = HStack({ spacing: 10, alignment: "top" }, [
    glyph(w, 26, 8, 12),
    VStack({ alignment: "leading", spacing: 4 }, [
      titleRow(w, 13.5),
      // No PR words here, Ready or not: the PR line below carries them (issue #79).
      HStack({ spacing: 6 }, [statusDot(w, 7), statusLabel(w, 12, "medium"), helpers(w, 12)])
        // Left-aligned by the frame, not a Spacer, as the chips row is.
        .frame({ maxWidth: "infinity", alignment: "leading" }),
      prLine(w, 11.5),
      when(
        "detail",
        () => !!detail(),
        () =>
          Text(detail)
            .font(12)
            .color(C.secondary)
            .lineLimit(2)
            .truncation("tail")
            .frame({ maxWidth: "infinity", alignment: "leading" }),
      ),
      chipsRow(w, true, false),
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

// Options board "Compact": the PR rides in the status line as text, and the
// message stays on the full card.
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
      // Compact cards have no chips row, so a Ready one in Background takes
      // the action on a line of its own.
      toReviewAction(w),
      progressBar(w, "compact-progress"),
    ])
      .frame({ maxWidth: "infinity", alignment: "leading" })
      .layoutPriority(1),
  ])
    .paddingHorizontal(11)
    .paddingVertical(9);
  return cardChrome(body, w, key, 11);
}

// "Row" density (Options board, .plain): dot, title, meta; selection is the
// white hairline pill, a drag lifts it in ink.
function denseRow(w: WsAccessor, key: string): View {
  // The number alone, so a row never widens; the words live on the cards.
  const pr = computed(() => prSummary(w()));
  const body = HStack({ spacing: 6 }, [
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
    cardUnread(w),
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
  ])
    .paddingLeading(25)
    .paddingTrailing(12)
    .paddingVertical(5)
    .hoverBackground(C.hover);
  const dragged = () => drag()?.id === key;
  const on = () => dragged() || isSelected(w());
  return ring(
    body,
    () => (on() ? C.card : "clear"),
    () => (dragged() ? C.select : on() ? C.cardEdge : "clear"),
    () => (dragged() ? 1.5 : 1),
    9,
  )
    .frame({ maxWidth: "infinity" })
    .onTap(() => selectWorkspace(w()?.id))
    .contextMenu(cardMenu(w));
}

/** The card at the density its lane uses (All view). */
export function cardFor(w: WsAccessor, entry: { id: string; lane: LaneKey }): View {
  const density = laneByKey(entry.lane).density;
  if (density === "full") return fullCard(w, entry.id);
  if (density === "compact") return compactCard(w, entry.id);
  return denseRow(w, entry.id);
}

// Projects view (board 2, #11): one row shape for every session. No glyph,
// since the project header carries it; title and age, status dot and label
// without the message, then the branch and PR chips. Selection is the card's
// ink ring.
export function projectRow(w: WsAccessor, key: string): View {
  // Spacing lives on the rows, so a row with no chips has no gap below it.
  const body = VStack({ alignment: "leading", spacing: 0 }, [
    titleRow(w, 12.5),
    HStack({ spacing: 6 }, [statusDot(w, 7), statusLabel(w, 12, "medium"), Spacer({ minLength: 0 })])
      .frame({ maxWidth: "infinity" })
      .paddingTop(2),
    chipsRow(w, true).paddingTop(() => (hasChipsRow(w(), true) ? 3 : 0)),
  ])
    .frame({ maxWidth: "infinity", alignment: "leading" })
    .paddingHorizontal(10)
    .paddingVertical(8);
  return cardChrome(body, w, key, 9);
}
