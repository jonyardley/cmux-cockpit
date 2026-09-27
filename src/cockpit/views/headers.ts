// The segmented mode control and the lane and project section headers.

import { projectBadge } from "../../shared/ui.ts";
import { dragging, dropLane } from "../drop.ts";
import { type LaneKey, laneByKey } from "../lanes.ts";
import {
  canOpenProject,
  chooseMode,
  emptyLaneNames,
  isCollapsed,
  isProjectCollapsed,
  laneCount,
  openProjectWorkspace,
  projectByKey,
  projectCount,
  quietLabel,
  quietProjects,
  toggleLane,
  toggleProject,
  toggleQuiet,
  wsById,
} from "../model.ts";
import { isMode, isSelected, projectsMode, quietCollapsed, selectWorkspace } from "../state.ts";
import { C } from "../theme.ts";
import { glyphButton, ring, statusDot, unreadBadge } from "./parts.ts";

function segButton(label: string, icon: string | null, on: () => boolean, set: () => void): View {
  return ZStack({}, [
    RoundedRectangle({ cornerRadius: 7 })
      .fill(() => (on() ? C.card : "clear"))
      .stroke(() => (on() ? C.cardEdge : "clear"))
      .strokeWidth(1),
    HStack({ spacing: 6 }, [
      ...(icon
        ? [
            Image(icon)
              .font(11)
              .color(() => (on() ? C.text : C.secondary)),
          ]
        : []),
      Text(label)
        .font(12)
        .weight("medium")
        .color(() => (on() ? C.text : C.secondary)),
    ]),
  ])
    .frame({ maxWidth: "infinity", height: 26 })
    .onTap(set);
}

// The outer inset lives on a wrapper: on the same node the runtime draws the
// background under every padding, so the track swallowed the margin.
export function segmented(): View {
  const track = HStack({ spacing: 0 }, [
    segButton("All", null, isMode("all"), () => chooseMode("all")),
    segButton("Projects", null, projectsMode, () => chooseMode("projects")),
  ]).padding(3);
  return VStack({ spacing: 0 }, [ring(track, C.segTrack, C.hairline, 1, 10).frame({ maxWidth: "infinity" })])
    .paddingHorizontal(14)
    .paddingTop(10)
    .paddingBottom(8);
}

function countPill(count: () => number): View {
  return Text(() => String(count()))
    .font(11)
    .weight("medium")
    .color(C.metaText)
    .lineLimit(1)
    .paddingHorizontal(7)
    .paddingVertical(1)
    .background(C.segTrack)
    .cornerRadius(10);
}

// The name wins the row's width and truncates rather than wrapping; the pill
// and hint stay on one line too, so no child of the header can wrap.
function headerName(name: string, color: string, weight: Weight = "semibold"): View {
  return Text(name).font(12.5).weight(weight).color(color).lineLimit(1).truncation("tail").layoutPriority(1);
}

function chevron(collapsed: () => boolean): View {
  return Image("chevron.right")
    .font(10)
    .weight("semibold")
    .color(C.faint)
    .rotation(() => (collapsed() ? 0 : 90))
    .frame({ width: 12, height: 16 });
}

// A lane's generated anchor with an agent or unread messages (issue #49): its
// dot and unread count sit on the header, shaded while it is selected, since
// it has no card to carry the selection. Its own onTap selects it rather
// than folding the lane, as the project header's "+" does.
function anchorStatus(anchorId: string): View {
  const w = () => wsById(anchorId);
  return HStack({ spacing: 5 }, [statusDot(w, 7), unreadBadge(w)])
    .paddingHorizontal(4)
    .frame({ height: 16 })
    .cornerRadius(6)
    .background(() => (isSelected(w()) ? C.anchorSelected : "clear"))
    .hoverBackground(C.hover)
    .onTap(() => selectWorkspace(anchorId));
}

function dropHint(target: () => boolean): View {
  return Text(() => (target() ? "Drop here" : ""))
    .font(11)
    .weight("medium")
    .color(C.heading)
    .lineLimit(1);
}

const laneMarker = (color: string): View =>
  RoundedRectangle({ cornerRadius: 3 }).fill(color).frame({ width: 9, height: 9 });

export function laneHeader(laneKey: LaneKey, anchorId: string | null): View {
  const lane = laneByKey(laneKey);
  const target = () => dropLane() === laneKey;
  return HStack({ spacing: 8 }, [
    chevron(() => isCollapsed(lane)),
    laneMarker(lane.color),
    headerName(lane.name, laneKey === "parked" ? C.faint : C.heading),
    ...(anchorId ? [anchorStatus(anchorId)] : []),
    countPill(() => laneCount(laneKey)),
    Spacer({ minLength: 4 }),
    dropHint(target),
  ])
    .paddingHorizontal(8)
    .paddingTop(14)
    .paddingBottom(5)
    .cornerRadius(8)
    .background(() => (target() ? C.dropTarget : "clear"))
    .hoverBackground(() => (target() ? C.dropTarget : C.hover))
    .frame({ maxWidth: "infinity" })
    .fixed()
    .onTap(() => toggleLane(lane));
}

// An empty lane (issue #50): a zone row that only opens while a card is
// dragged, and folds to nothing at rest (the row stays, so the drop index
// never shifts). The renderer has no dashed stroke, so the open zone is a
// quiet ring that turns solid ink under the pointer.
export function dropZone(laneKey: LaneKey): View {
  const lane = laneByKey(laneKey);
  const target = () => dropLane() === laneKey;
  const open = (v: number) => () => (dragging() ? v : 0);
  const row = HStack({ spacing: 8 }, [
    RoundedRectangle({ cornerRadius: 3 })
      .fill(() => (dragging() ? lane.color : "clear"))
      .frame({ width: open(9), height: open(9) }),
    Text(() => (dragging() ? lane.name : ""))
      .font(12.5)
      .weight("semibold")
      .color(C.faint)
      .lineLimit(1)
      .truncation("tail")
      .layoutPriority(1),
    Spacer({ minLength: 0 }),
    dropHint(target),
  ])
    .paddingHorizontal(open(10))
    .paddingVertical(open(8));
  const zone = ring(
    row,
    () => (target() ? C.zoneLit : dragging() ? C.ground : "clear"),
    () => (target() ? C.heading : dragging() ? C.zoneEdge : "clear"),
    open(1),
    8,
  );
  return VStack({ spacing: 0 }, [zone.frame({ maxWidth: "infinity" })])
    .paddingTop(open(8))
    .fixed();
}

// The empty lanes at rest (issue #50): one quiet line, no tap. It folds to
// nothing while a card is dragged, when the zones open instead.
export function emptyFold(): View {
  const rest = (v: number) => () => (dragging() ? 0 : v);
  return Text(() => (dragging() ? "" : "Empty: " + emptyLaneNames().join(" · ")))
    .font(11.5)
    .color(C.faint)
    .lineLimit(1)
    .truncation("tail")
    .paddingHorizontal(8)
    .paddingTop(rest(14))
    .paddingBottom(rest(5))
    .frame({ maxWidth: "infinity", alignment: "leading" })
    .fixed();
}

const badge = (k: string, size: number, font: number): View => {
  const p = projectByKey(k);
  return projectBadge(() => p, size, font, C.text, "semibold");
};

// Projects with no sessions (issue #54): a muted header that folds, then a
// short row each, so the busy projects stand out and the quiet ones still
// have names. The renderer has no hover-only views, so the row's plus is a
// faint glyph at rest and the whole row is the button.
export function quietHeader(): View {
  const row = HStack({ spacing: 8 }, [
    chevron(quietCollapsed),
    Text("Quiet").font(11.5).weight("medium").color(C.faint).lineLimit(1),
    countPill(() => quietProjects().length),
    Spacer({ minLength: 0 }),
  ])
    .paddingHorizontal(8)
    .paddingVertical(4)
    .cornerRadius(8)
    .hoverBackground(C.hover)
    .frame({ maxWidth: "infinity" })
    .onTap(toggleQuiet);
  // The gap above sits on a wrapper, so the hover shade and tap stop at the row.
  return VStack({ spacing: 0 }, [row]).paddingTop(10);
}

// One quiet project. A project with no folder has no tap and sits dimmed, so
// it does not read as a button; its menu item only says why.
export function quietRow(k: string): View {
  const open = canOpenProject(k);
  const row = HStack({ spacing: 8 }, [
    badge(k, 16, 9),
    headerName(projectByKey(k).name, C.secondary, "regular"),
    Spacer({ minLength: 4 }),
    ...(open ? [Image("plus").font(10).weight("semibold").color(C.faint)] : []),
  ])
    .paddingHorizontal(8)
    .paddingVertical(3)
    .cornerRadius(7)
    .frame({ maxWidth: "infinity" })
    .contextMenu([Button(quietLabel(k), () => openProjectWorkspace(k))]);
  if (!open) return row.opacity(0.55);
  return row.hoverBackground(C.hover).onTap(() => openProjectWorkspace(k));
}

export function projectHeader(k: string): View {
  const p = projectByKey(k);
  return HStack({ spacing: 8 }, [
    chevron(() => isProjectCollapsed(k)),
    badge(k, 18, 10),
    headerName(p.name, C.heading),
    countPill(() => projectCount(k)),
    Spacer({ minLength: 4 }),
    ...(canOpenProject(k) ? [glyphButton("plus", 20, 11, C.secondary, () => openProjectWorkspace(k))] : []),
  ])
    .paddingHorizontal(8)
    .paddingTop(14)
    .paddingBottom(5)
    .cornerRadius(8)
    .hoverBackground(C.hover)
    .frame({ maxWidth: "infinity" })
    .onTap(() => toggleProject(k));
}
