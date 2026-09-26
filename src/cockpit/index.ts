// Cockpit: Jon's lane-based workspace sidebar.
//
// Layout, top to bottom:
//   1. All | Projects segmented control (author state).
//   2. "Needs you" strip: every workspace whose agent is waiting on input.
//   3. Lanes (cmux workspace groups matched by NAME): Main activity, For
//      review, Background, Parked, then Unsorted (anything not in a lane).
//
// The lanes are ONE flat Reorderable of fixed headers plus card rows, so a
// card can be dragged between lanes in one gesture (see drop.ts).

import { handleMove, isForeignAnchor } from "./drop.ts";
import { flatEntries, projectEntries, wsById } from "./model.ts";
import { setDrag } from "./state.ts";
import { cardFor, projectRow } from "./views/cards.ts";
import { laneHeader, projectHeader, segmented } from "./views/headers.ts";
import { needsStrip } from "./views/needs.ts";
import { emptyRow } from "./views/parts.ts";

sidebar(() =>
  VStack({ spacing: 0, alignment: "leading" }, [
    segmented(),
    needsStrip(),
    VStack({ spacing: 0 }, [
      Reorderable(
        {
          items: flatEntries,
          key: (e) => e.id,
          spacing: 2,
          onMove: handleMove,
          onDragChange: setDrag,
        },
        (e) => {
          const entry = e(); // kind, lane and wsId are fixed per key
          if (entry.kind === "header") return laneHeader(entry.lane);
          const row = cardFor(() => wsById(entry.wsId), entry);
          return isForeignAnchor(entry.wsId) ? row.fixed() : row;
        },
      ),
    ]).paddingHorizontal(10),
    VStack({ spacing: 2 }, [
      ForEach({ items: projectEntries, key: (e) => e.id }, (e) => {
        const entry = e();
        if (entry.kind === "header") return projectHeader(entry.project);
        if (entry.kind === "empty") return emptyRow("No sessions");
        return projectRow(() => wsById(entry.wsId), entry.id);
      }),
    ]).paddingHorizontal(10),
    Spacer(),
  ]).paddingBottom(12),
);
