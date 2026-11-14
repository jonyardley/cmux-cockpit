// The Now and Details switch at the top of the agents panel (#397), drawn
// as the Cockpit's All and Projects switch (docs/design.md, View switch):
// two tappable tabs on a rounded track, since the renderer has no tab view.
// Each tab is built once and recoloured as the choice moves.

import { ring } from "../../shared/ui.ts";
import { chooseTab, type Tab, tabOf } from "../details.ts";
import { SWITCH, T } from "../theme.ts";

// A tab's height, 26, holds its 1pt edge, so the words' frame is 2 shorter.
const TAB_HEIGHT = 26;
const EDGE = 1;
// The track's inner padding, 3, holds its own 1pt edge.
const INSET = 3;

// cmux applies a node's background before its frame, whatever order they
// are chained in, and its maxWidth frame is always leading. So the face
// sits on a stack that is full width by its own content, spacers either
// side of the words, which centres them; a frame on the words would widen
// them after the face and leave it hugging the word.
function tab(t: Tab, label: string): View {
  const on = () => tabOf() === t;
  const words = Text(label)
    .font(12)
    .weight("medium")
    .color(() => (on() ? T.text : T.secondary))
    .lineLimit(1)
    .frame({ height: TAB_HEIGHT - 2 * EDGE });
  return ring(
    HStack({ spacing: 0 }, [Spacer({ minLength: 0 }), words, Spacer({ minLength: 0 })]),
    () => (on() ? SWITCH.tab : "clear"),
    () => (on() ? SWITCH.tabEdge : "clear"),
    EDGE,
    7,
    // Only the tab not chosen lights under the pointer.
    { hover: { face: () => (on() ? SWITCH.tab : SWITCH.hover) } },
  ).onTap(() => chooseTab(t));
}

/** The two tabs on their track, the full width of the panel. */
export function tabSwitch(): View {
  return ring(
    HStack({ spacing: 0 }, [tab("now", "Now"), tab("details", "Details")]).padding(INSET - EDGE),
    SWITCH.track,
    SWITCH.trackEdge,
    EDGE,
    10,
  );
}
