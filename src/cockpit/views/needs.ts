// The "Needs you" strip: every workspace whose agent is waiting on input.
// A row is amber while its agent is asking (a permission or a question,
// with the reason under the title) and clay while it is only its turn.

import { dismissNeeds } from "../../shared/needs.ts";
import { displayTitle } from "../../shared/titles.ts";
import { haloDot, meta, ring, sectionTitle, when } from "../../shared/ui.ts";
import { jumpNext, needsList, needsMore, needsShown, nextStep } from "../model.ts";
import { selectWorkspace } from "../state.ts";
import { ageOf, needsDetail, needsRowEdge, statusInfo } from "../status.ts";
import { C } from "../theme.ts";
import { cardMenu, glyphButton, type WsAccessor } from "./parts.ts";

function needsRow(w: WsAccessor): View {
  // One status per change, read by the dot and its halo.
  const info = computed(() => statusInfo(w()));
  const row = HStack({ spacing: 10, alignment: "top" }, [
    // 13pt halo frame: top 2 keeps the dot centred on the title line.
    haloDot(
      Circle({ size: 7 }).fill(() => info().dot ?? C.clay),
      () => info().halo,
      7,
    ).paddingTop(2),
    VStack({ alignment: "leading", spacing: 1 }, [
      Text(() => displayTitle(w()))
        .font(12.5)
        .weight("semibold")
        .color(C.text)
        .lineLimit(1)
        .truncation("middle"),
      Text(() => needsDetail(w()))
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
  return ring(row, C.card, () => needsRowEdge(w()), 1, 9)
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
      // Filling the width here, as the strip rows' title stack does, is what
      // carries the white face edge to edge and pushes the count right
      // (issue #89); a frame on the HStack left the face hugging the text.
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
              sectionTitle("NEEDS YOU", C.clayText),
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
