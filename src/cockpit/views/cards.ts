// Workspace cards at the three lane densities (full, compact, row), plus the
// one row shape the Projects view uses.

import { prOf } from "../../shared/prs.ts";
import { oneLine } from "../../shared/text.ts";
import { displayTitle } from "../../shared/titles.ts";
import { type LaneKey, laneByKey } from "../lanes.ts";
import { isSelected, selectWorkspace } from "../model.ts";
import { drag } from "../state.ts";
import { ageOf } from "../status.ts";
import { C } from "../theme.ts";
import {
  cardChrome,
  cardMenu,
  chipsFor,
  chipsRow,
  glyph,
  meta,
  ring,
  statusDot,
  statusLabel,
  titleRow,
  unreadBadge,
  type WsAccessor,
} from "./parts.ts";

const prNumberOf = (w: Workspace | undefined): number | undefined => prOf(w)?.number;

function fullCard(w: WsAccessor, key: string): View {
  const detail = () => {
    const x = w();
    const m = oneLine(x?.latestMessage, 90) || oneLine(x?.latestPrompt, 90) || oneLine(x?.description, 90);
    return m ? "· " + m : "";
  };
  const body = HStack({ spacing: 10, alignment: "top" }, [
    glyph(w, 26, 8, 12),
    VStack({ alignment: "leading", spacing: 4 }, [
      titleRow(w, 13.5),
      HStack({ spacing: 6 }, [
        statusDot(w, 7),
        statusLabel(w, 12, "medium"),
        Text(detail).font(12).color(C.secondary).lineLimit(1).truncation("tail"),
        Spacer({ minLength: 0 }),
      ]).frame({ maxWidth: "infinity" }),
      chipsRow(w, true),
    ])
      .frame({ maxWidth: "infinity", alignment: "leading" })
      .layoutPriority(1),
  ])
    .paddingLeading(10)
    .paddingTrailing(12)
    .paddingVertical(11);
  return cardChrome(body, w, key, 12);
}

// Options board "Compact": the PR rides in the status line as text.
export function compactCard(w: WsAccessor, key: string): View {
  const prText = () => {
    const n = prNumberOf(w());
    return n ? "· #" + n : "";
  };
  const body = HStack({ spacing: 9 }, [
    glyph(w, 22, 7, 11),
    VStack({ alignment: "leading", spacing: 3 }, [
      titleRow(w, 13),
      HStack({ spacing: 6 }, [
        statusDot(w, 6),
        statusLabel(w, 11.5, "regular"),
        Text(prText).font(11.5).color(C.secondary).lineLimit(1).layoutPriority(2),
        Spacer({ minLength: 0 }),
      ]).frame({ maxWidth: "infinity" }),
    ])
      .frame({ maxWidth: "infinity", alignment: "leading" })
      .layoutPriority(1),
  ])
    .paddingHorizontal(11)
    .paddingVertical(9);
  return cardChrome(body, w, key, 11);
}

// "Row" density (Options board, .plain): dot, title, meta; selection is the
// white hairline pill, a drag lifts it in clay.
function denseRow(w: WsAccessor, key: string): View {
  const trailing = () => {
    const x = w();
    const n = prNumberOf(x);
    return (n ? "#" + n + "  " : "") + ageOf(x);
  };
  const body = HStack({ spacing: 6 }, [
    statusDot(w, 7),
    Text(() => displayTitle(w()))
      .font(12.5)
      .weight(() => (isSelected(w()) ? "medium" : "regular"))
      .color(C.text)
      .lineLimit(1)
      .truncation("middle")
      .layoutPriority(1),
    Spacer({ minLength: 4 }),
    unreadBadge(w),
    meta(trailing, "#6B6A64"),
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
    () => (dragged() ? C.clay : on() ? C.cardEdge : "clear"),
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
// clay ring.
export function projectRow(w: WsAccessor, key: string): View {
  // Spacing lives on the rows, so a row with no chips has no gap below it.
  const body = VStack({ alignment: "leading", spacing: 0 }, [
    titleRow(w, 12.5),
    HStack({ spacing: 6 }, [statusDot(w, 7), statusLabel(w, 12, "medium"), Spacer({ minLength: 0 })])
      .frame({ maxWidth: "infinity" })
      .paddingTop(2),
    chipsRow(w, true).paddingTop(() => (chipsFor(w(), true).length ? 3 : 0)),
  ])
    .frame({ maxWidth: "infinity", alignment: "leading" })
    .paddingHorizontal(10)
    .paddingVertical(8);
  return cardChrome(body, w, key, 9);
}
