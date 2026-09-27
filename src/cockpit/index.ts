// Cockpit: Jon's lane-based workspace sidebar.
//
// Layout, top to bottom:
//   1. All | Projects segmented control (author state).
//   2. "Needs you" strip: every workspace whose agent is waiting on input.
//   3. Lanes (cmux workspace groups matched by NAME): Main activity, For
//      review, Background, Parked, then Unsorted (anything not in a lane).
//      Empty lanes fold into one line, and open as drop zones mid-drag.
//
// The lanes are ONE flat Reorderable of fixed headers plus card rows, so a
// card can be dragged between lanes in one gesture (see drop.ts).
//
// Both panels stay built; the tab only hides one (model.ts's panelOpacity
// and panelMaxHeight), so a switch never rebuilds a list.

import type { ViewMode } from "../../scripts/state-config.ts";
import { handleDragChange, handleMove, isForeignAnchor } from "./drop.ts";
import { flatEntries, panelMaxHeight, panelOpacity, projectEntries, wsById } from "./model.ts";
import { cardFor, projectRow } from "./views/cards.ts";
import { dropZone, emptyFold, laneHeader, projectHeader, quietLine, segmented } from "./views/headers.ts";
import { needsStrip } from "./views/needs.ts";

sidebar(() =>
  VStack({ spacing: 0, alignment: "leading" }, [
    segmented(),
    needsStrip(),
    panel("all", lanesPanel()),
    panel("projects", projectsPanel()),
    Spacer(),
  ]).paddingBottom(12),
);

// Top-aligned, so a zero-height panel's rows overflow downward, unseen.
function panel(m: ViewMode, content: View): View {
  return content.opacity(panelOpacity(m)).frame({ maxHeight: panelMaxHeight(m), alignment: "top" });
}

function lanesPanel(): View {
  return VStack({ spacing: 0 }, [
    Reorderable(
      {
        items: flatEntries,
        key: (e) => e.id,
        spacing: 2,
        onMove: handleMove,
        onDragChange: handleDragChange,
      },
      (e) => {
        const entry = e(); // kind, lane, anchorId and wsId are fixed per key
        if (entry.kind === "header") return laneHeader(entry.lane, entry.anchorId);
        if (entry.kind === "zone") return dropZone(entry.lane);
        if (entry.kind === "fold") return emptyFold();
        const row = cardFor(() => wsById(entry.wsId), entry);
        return isForeignAnchor(entry.wsId) ? row.fixed() : row;
      },
    ),
  ]).paddingHorizontal(10);
}

function projectsPanel(): View {
  return VStack({ spacing: 2 }, [
    ForEach({ items: projectEntries, key: (e) => e.id }, (e) => {
      const entry = e();
      if (entry.kind === "header") return projectHeader(entry.project);
      if (entry.kind === "quiet") return quietLine();
      return projectRow(() => wsById(entry.wsId), entry.id);
    }),
  ]).paddingHorizontal(10);
}
