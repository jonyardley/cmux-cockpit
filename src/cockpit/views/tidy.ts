// "N merged, ready to tidy" at the cockpit's foot: a count, the branches on
// one line, and a Tidy button that opens a workspace with the close-out
// typed on its prompt (tidy.ts). Hidden while nothing has merged.

import { chipHover, ring, sectionTitle, when } from "../../shared/ui.ts";
import { C } from "../theme.ts";
import { tidy, tidyBranches } from "../tidy.ts";

const TIDY_CHIP = { bg: C.card, fg: C.tidyText, edge: C.tidyEdge };

const label = (): string => {
  const n = tidyBranches().length;
  return n + " merged, ready to tidy";
};

// Its own onTap on a hugging chip, like "To review →".
function tidyButton(): View {
  const body = Text("Tidy").font(11).weight("semibold").color(C.tidyText).paddingHorizontal(9).paddingVertical(2);
  return ring(body, TIDY_CHIP.bg, TIDY_CHIP.edge, 1, 6, { hug: true, hover: chipHover(() => TIDY_CHIP) }).onTap(tidy);
}

export function tidyStrip(): View {
  return when(
    "tidy",
    () => tidyBranches().length > 0,
    () =>
      VStack({ spacing: 0 }, [
        ring(
          VStack({ alignment: "leading", spacing: 4 }, [
            HStack({ spacing: 7 }, [
              Image("checkmark.circle.fill").font(10).color(C.tidyText),
              sectionTitle(() => label().toUpperCase(), C.tidyText),
              Spacer(),
              tidyButton(),
            ]),
            Text(() => tidyBranches().join(" · "))
              .font(11.5)
              .color(C.secondary)
              .lineLimit(1)
              .truncation("tail"),
          ]).padding(9),
          C.tidyBg,
          C.tidyEdge,
          1,
          13,
        ),
      ])
        .paddingHorizontal(10)
        .paddingTop(8),
  );
}
