// The segmented mode control and the lane and project section headers.

import { glyphColor } from "../../shared/contrast.ts";
import { dropLane } from "../drop.ts";
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
  selectWorkspace,
  toggleLane,
  toggleProject,
  wsById,
} from "../model.ts";
import { mode, projectsMode } from "../state.ts";
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
    segButton(
      "All",
      null,
      () => mode() === "all",
      () => chooseMode("all"),
    ),
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
function headerName(name: string, color: string): View {
  return Text(name).font(12.5).weight("semibold").color(color).lineLimit(1).truncation("tail").layoutPriority(1);
}

function chevron(collapsed: () => boolean): View {
  return Image("chevron.right")
    .font(10)
    .weight("semibold")
    .color(C.faint)
    .rotation(() => (collapsed() ? 0 : 90))
    .frame({ width: 12, height: 16 });
}

// A lane's generated anchor with an agent in it (issue #49): its dot and
// unread count sit on the header, and a tap there selects it rather than
// folding the lane.
function anchorStatus(anchorId: string): View {
  const w = () => wsById(anchorId);
  return HStack({ spacing: 5 }, [statusDot(w, 7), unreadBadge(w)])
    .paddingHorizontal(4)
    .frame({ height: 16 })
    .cornerRadius(6)
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

// An empty lane mid-drag (issue #50). The renderer has no dashed stroke, so
// the zone is a quiet ring that turns solid ink under the pointer.
export function dropZone(laneKey: LaneKey): View {
  const lane = laneByKey(laneKey);
  const target = () => dropLane() === laneKey;
  const row = HStack({ spacing: 8 }, [
    laneMarker(lane.color),
    headerName(lane.name, C.faint),
    Spacer({ minLength: 4 }),
    dropHint(target),
  ])
    .paddingHorizontal(10)
    .paddingVertical(8);
  const zone = ring(
    row,
    () => (target() ? C.zoneLit : C.ground),
    () => (target() ? C.heading : C.zoneEdge),
    1,
    8,
  );
  return VStack({ spacing: 0 }, [zone.frame({ maxWidth: "infinity" })])
    .paddingTop(8)
    .fixed();
}

// The empty lanes at rest (issue #50): one quiet line, no tap.
export function emptyFold(): View {
  return Text(() => "Empty: " + emptyLaneNames().join(" · "))
    .font(11.5)
    .color(C.faint)
    .lineLimit(1)
    .truncation("tail")
    .paddingHorizontal(8)
    .paddingTop(14)
    .paddingBottom(5)
    .frame({ maxWidth: "infinity", alignment: "leading" })
    .fixed();
}

export function projectHeader(k: string): View {
  const p = projectByKey(k);
  return HStack({ spacing: 8 }, [
    chevron(() => isProjectCollapsed(k)),
    ZStack({}, [
      RoundedRectangle({ cornerRadius: 5 }).fill(p.color),
      Image(p.icon).font(10).weight("semibold").color(glyphColor(p.color, C.text)),
    ]).frame({ width: 18, height: 18 }),
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
