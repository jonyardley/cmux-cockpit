// The "Needs you" strip: every workspace whose agent is waiting on input.

import { dismissNeeds } from "../../shared/needs.ts";
import { cardMessage, oneLine } from "../../shared/text.ts";
import { displayTitle } from "../../shared/titles.ts";
import { haloDot, when } from "../../shared/ui.ts";
import { jumpNext, needsList, needsMore, needsShown, nextStep } from "../model.ts";
import { selectWorkspace } from "../state.ts";
import { ageOf } from "../status.ts";
import { C } from "../theme.ts";
import { cardMenu, glyphButton, meta, ring, type WsAccessor } from "./parts.ts";

function needsRow(w: WsAccessor): View {
  const row = HStack({ spacing: 10, alignment: "top" }, [
    // 13pt halo frame: top 2 keeps the dot centred on the title line.
    haloDot(Circle({ size: 7 }).fill(C.clay), C.clayHalo, 7).paddingTop(2),
    VStack({ alignment: "leading", spacing: 1 }, [
      Text(() => displayTitle(w()))
        .font(12.5)
        .weight("semibold")
        .color(C.text)
        .lineLimit(1)
        .truncation("middle"),
      Text(() => oneLine(cardMessage(w()), 80) || "Waiting for your reply")
        .font(12)
        .color(C.secondary)
        .lineLimit(1)
        .truncation("tail"),
    ])
      .frame({ maxWidth: "infinity", alignment: "leading" })
      .layoutPriority(1),
    meta(() => ageOf(w()), C.secondary),
    glyphButton("xmark", 16, 8.5, C.tertiary, () => dismissNeeds(w())),
  ])
    .paddingHorizontal(10)
    .paddingVertical(9)
    .hoverBackground(C.needsHover);
  // One selection ring: the card below carries it, so the row keeps its edge.
  return ring(row, C.card, C.needsRowEdge, 1, 9)
    .frame({ maxWidth: "infinity" })
    .onTap(() => selectWorkspace(w()?.id))
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
      .layoutPriority(1),
    Text(() => {
      const s = step();
      return s ? s.position + " of " + s.total : "";
    })
      .font(10)
      .monospaced()
      .color(C.faint)
      .lineLimit(1),
  ])
    .paddingHorizontal(8)
    .paddingVertical(5)
    .frame({ maxWidth: "infinity" })
    .hoverBackground(C.needsHover);
  return when(
    "next",
    () => step() !== null,
    () =>
      VStack({ spacing: 0 }, [ring(row, C.card, C.needsEdge, 1, 7).onTap(jumpNext)])
        .paddingHorizontal(10)
        .paddingTop(6),
  );
}

// "+2 more" under the capped rows, in line with the rows' titles: a row's
// 1pt edge, 10 padding, 13pt halo and 10 spacing put its title at 34.
function moreLine(): View {
  return when(
    "more",
    () => needsMore() > 0,
    () =>
      Text(() => "+" + needsMore() + " more")
        .font(11.5)
        .color(C.clayText)
        .lineLimit(1)
        .paddingLeading(34)
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
            HStack({ spacing: 7 }, [
              Image("bell.fill").font(10).color(C.clayText),
              Text("NEEDS YOU").font(10.5).weight("semibold").color(C.clayText),
              Spacer(),
              Text(() => String(needsList().length))
                .font(10.5)
                .weight("semibold")
                .color(C.clayText),
            ]).paddingHorizontal(2),
            ForEach({ items: needsShown, key: (w) => w.id }, (w) => needsRow(w)),
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
