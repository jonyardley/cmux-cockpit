// The "Needs you" strip: every workspace whose agent is waiting on input.
// A row is amber while its agent is asking (a permission or a question,
// with the reason under the title) and clay while it is only its turn. Each
// row carries its project's tile and names the lane (or project group) its
// card left a placeholder in.

import { displayTitle } from "../../shared/titles.ts";
import { countPill, meta, motionList, ring, sectionTitle, when } from "../../shared/ui.ts";
import {
  dismissWaiting,
  jumpNext,
  needsList,
  needsMore,
  needsShown,
  needsWaitLate,
  needsWaitText,
  nextStep,
  originOf,
  revealWorkspace,
} from "../model.ts";
import { isSelected } from "../state.ts";
import { ageOf, countColors, needsInk, needsLine, needsRowEdge } from "../status.ts";
import { C } from "../theme.ts";
import { laneMarker } from "./headers.ts";
import { cardMenu, glyph, glyphButton, type WsAccessor } from "./parts.ts";

// The lane's marker and name, or the project group's in Projects view.
function originLine(w: WsAccessor): View {
  const origin = computed(() => originOf(w()));
  return HStack({ spacing: 5 }, [
    laneMarker(() => origin().color, 7),
    Text(() => origin().name)
      .font(11)
      .color(C.metaText)
      .lineLimit(1)
      .truncation("tail"),
  ]).frame({ maxWidth: "infinity", alignment: "leading" });
}

function needsRow(w: WsAccessor): View {
  const row = HStack({ spacing: 10, alignment: "top" }, [
    glyph(w, 20, 5, 10),
    VStack({ alignment: "leading", spacing: 2 }, [
      Text(() => displayTitle(w()))
        .font(12.5)
        .weight("semibold")
        .color(C.text)
        .lineLimit(1)
        .truncation("middle"),
      Text(() => needsLine(w()))
        .font(12)
        .color(() => needsInk(w()))
        .lineLimit(1)
        .truncation("tail"),
      originLine(w),
    ])
      .frame({ maxWidth: "infinity", alignment: "leading" })
      .layoutPriority(1),
    meta(() => ageOf(w()), C.secondary),
    glyphButton("xmark", 16, 8.5, C.tertiary, () => dismissWaiting(w())),
  ])
    .paddingHorizontal(10)
    .paddingVertical(9)
    .hoverBackground(C.needsHover);
  // The card's selection outline: a session the strip lists has no card
  // below to carry it.
  const selected = () => isSelected(w());
  return ring(
    row,
    C.card,
    () => (selected() ? C.selectEdge : needsRowEdge(w())),
    () => (selected() ? 1.5 : 1),
    9,
  )
    .frame({ maxWidth: "infinity" })
    .onTap(() => revealWorkspace(w()))
    .contextMenu(cardMenu(w));
}

// Above the strip (issue #74): opens the next workspace that needs Jon, then
// the Ready ones, and says which and how far along the queue it is.
// Hidden when nothing needs him or is Ready.
export function nextButton(): View {
  const step = () => nextStep();
  const row = HStack({ spacing: 6 }, [
    Text(() => "Next: " + displayTitle(step()?.target))
      .font(11.5)
      .weight("semibold")
      .color(C.clayText)
      .lineLimit(1)
      .truncation("middle")
      // Filling the width here, as the strip rows' title stack does, pushes
      // the count right and carries the hover face across the row. The ring
      // face fills on its own since issue #93.
      .frame({ maxWidth: "infinity", alignment: "leading" })
      .layoutPriority(1),
    // In a card age's face and colour, so the two read as one kind of text.
    meta(() => {
      const s = step();
      return s ? s.position + " of " + s.total : "";
    }, C.metaText),
  ])
    .paddingHorizontal(8)
    .paddingVertical(5)
    .hoverBackground(C.needsHover);
  return when(
    "next",
    () => step() !== null,
    () =>
      VStack({ spacing: 0 }, [ring(row, C.card, C.needsEdge, 1, 7).frame({ maxWidth: "infinity" }).onTap(jumpNext)])
        .paddingHorizontal(10)
        .paddingTop(6),
  );
}

// "+2 more" under the capped rows, in line with the rows' titles: a row's
// 1pt edge, 10 padding, 20pt tile and 10 spacing put its title at 41.
function moreLine(): View {
  return when(
    "more",
    () => needsMore() > 0,
    () =>
      Text(() => "+" + needsMore() + " more")
        .font(11.5)
        .color(C.clayText)
        .lineLimit(1)
        .paddingLeading(41)
        .frame({ maxWidth: "infinity", alignment: "leading" }),
  );
}

// Hidden when empty. The count says how many wait, the rows stop at four.
export function needsStrip(): View {
  return when(
    "needs",
    () => needsList().length > 0,
    () =>
      // Top 6 sits under the Next button when it shows, else adds to the
      // segmented control's 8 for the board's 14 above the strip; bottom 8
      // + the lane header's 14 section gap matches its gap below.
      VStack({ spacing: 0 }, [
        ring(
          VStack({ alignment: "leading", spacing: 6 }, [
            // The count in a pill after the name, tinted as a lane's is.
            HStack({ spacing: 7 }, [
              sectionTitle("NEEDS YOU", C.clayText),
              countPill(
                () => String(needsList().length),
                () => countColors(needsList()),
              ),
              Spacer({ minLength: 0 }),
              // How long the oldest ask has waited: clay from 30 minutes.
              meta(needsWaitText, () => (needsWaitLate() ? C.clayText : C.secondary)),
            ]).paddingHorizontal(5),
            motionList({ items: needsShown, key: (w) => w.id, spacing: 6 }, (w) => needsRow(w)),
            moreLine(),
          ]).padding(9),
          C.needsBg,
          C.needsEdge,
          1,
          13,
        ),
      ])
        .paddingHorizontal(10)
        .paddingTop(6)
        .paddingBottom(8),
  );
}
