// Cockpit: Jon's lane-based workspace sidebar.
//
// Layout, top to bottom:
//   0. Only when config/state.json could not be read at build: one line
//      saying so, so the board does not just look empty (issue #78).
//   1. All | Projects segmented control (author state).
//   2. Next: opens what needs you, then what is Ready, one press at a time.
//   3. "Needs you" strip: the workspaces whose agent is waiting on input, the
//      first four of them, then "+N more".
//   4. Lanes (cmux workspace groups matched by NAME): Main activity, For
//      review, Background, Parked, then Unsorted (anything not in a lane).
//      Cards sort by state inside a lane; a card Needs you lists is not
//      repeated there. An empty lane is a faint header with a "0" count,
//      still a drop target.
//
// The lanes are ONE flat Reorderable of fixed headers plus card rows, so a
// card can be dragged between lanes in one gesture (see drop.ts).
//
// Both panels stay built; the tab only hides one (model.ts's panelOpacity
// and panelMaxHeight), so a switch never rebuilds a list.

import type { ViewMode } from "../../scripts/state-config.ts";
import { stateNotice } from "../shared/freshness.ts";
import { faintLine } from "../shared/notice.ts";
import { motionList } from "../shared/ui.ts";
import { handleDragChange, handleMove, isForeignAnchor } from "./drop.ts";
import { flatEntries, panelMaxHeight, panelOpacity, projectEntries, wsById } from "./model.ts";
import { C } from "./theme.ts";
import { cardFor, placeholderRow, projectRow } from "./views/cards.ts";
import { projectEditor } from "./views/editor.ts";
import {
  dropZone,
  laneHeader,
  newProjectRow,
  projectHeader,
  quietHeader,
  quietRow,
  segmented,
} from "./views/headers.ts";
import { needsStrip, nextButton } from "./views/needs.ts";

// The unreadable-state line, gone entirely while the state read fine.
function stateLine(): View {
  return faintLine("state-notice", stateNotice, C.clayText, 14).paddingVertical(6);
}

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
        // Kind, anchorId and wsId are fixed per key, and so is a header's or
        // zone's lane. A card's lane is not: its key leaves the lane out.
        const entry = e();
        if (entry.kind === "header") return laneHeader(entry.lane, entry.anchorId);
        if (entry.kind === "zone") return dropZone(entry.lane);
        // Its session sits in Needs you; the placeholder only marks the spot.
        if (entry.kind === "ghost") return placeholderRow(() => wsById(entry.wsId)).fixed(true);
        // Reactive, since a card keeps its row when its group changes.
        return cardFor(() => wsById(entry.wsId), entry.id).fixed(() => isForeignAnchor(entry.wsId));
      },
    ),
  ]).paddingHorizontal(10);
}

function projectsPanel(): View {
  return VStack({ spacing: 0 }, [
    motionList({ items: projectEntries, key: (e) => e.id, spacing: 2 }, (e) => {
      const entry = e();
      if (entry.kind === "header") return projectHeader(entry.project);
      if (entry.kind === "quietHeader") return quietHeader();
      if (entry.kind === "quietRow") return quietRow(entry.project);
      if (entry.kind === "editor") return projectEditor(entry.project);
      if (entry.kind === "newRow") return newProjectRow();
      if (entry.kind === "ghost") return placeholderRow(() => wsById(entry.wsId));
      return projectRow(() => wsById(entry.wsId), entry.id);
    }),
  ]).paddingHorizontal(10);
}

// Last, since cmux builds the root as soon as it is registered: every
// helper above must already exist.
sidebar(() =>
  VStack({ spacing: 0, alignment: "leading" }, [
    stateLine(),
    segmented(),
    nextButton(),
    needsStrip(),
    panel("all", lanesPanel()),
    panel("projects", projectsPanel()),
    Spacer(),
  ]).paddingBottom(12),
);
