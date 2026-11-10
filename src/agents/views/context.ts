// The Context card's rows: a label and its percent, a stepped bar, and a
// faint line under it. The bar is twenty steps, each 5%, since the renderer
// has no way to tint a ProgressView or size a fill to a share of the row.

import type { Last } from "../../shared/list.ts";
import { when } from "../../shared/ui.ts";
import { type Meter, percentColor, STEPS, stepColor } from "../context.ts";
import { T } from "../theme.ts";
import { ruled } from "./parts.ts";

const STEP_INDICES = Array.from({ length: STEPS }, (_, i) => i);

function bar(m: () => Meter): View {
  return HStack(
    { spacing: 2 },
    STEP_INDICES.map((i) =>
      RoundedRectangle({ cornerRadius: 1.5 })
        .fill(() => stepColor(m(), i))
        .frame({ maxWidth: "infinity", height: 6 }),
    ),
  ).frame({ maxWidth: "infinity" });
}

/** One meter: "This chat" and "18%", the bar, then "178k of 1M". */
export function meterRow(m: () => Last<Meter>): View {
  const row = VStack({ spacing: 5, alignment: "leading" }, [
    HStack({ spacing: 6 }, [
      Text(() => m().label)
        .font(12.5)
        .color(T.text)
        .lineLimit(1),
      Spacer({ minLength: 4 }),
      Text(() => m().percent + "%")
        .font(11.5)
        .monospaced()
        .color(() => percentColor(m())),
    ]),
    bar(m),
    when(
      "detail",
      () => m().detail !== "",
      () =>
        Text(() => m().detail)
          .font(11)
          .color(T.tertiary)
          .lineLimit(1),
    ),
  ])
    .paddingHorizontal(12)
    .paddingVertical(9)
    .frame({ maxWidth: "infinity", alignment: "leading" });
  return ruled(row, () => m().last);
}
