// The segmented mode control and the lane and project section headers.

import { glyphColor } from "../../shared/contrast.ts";
import { dropLane } from "../drop.ts";
import { type LaneKey, laneByKey } from "../lanes.ts";
import {
  canOpenProject,
  isCollapsed,
  isProjectCollapsed,
  laneCount,
  openProjectWorkspace,
  projectByKey,
  projectCount,
  toggleLane,
  toggleProject,
} from "../model.ts";
import { mode, projectsMode, setMode } from "../state.ts";
import { C } from "../theme.ts";
import { glyphButton, ring } from "./parts.ts";

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
      () => setMode("all"),
    ),
    segButton("Projects", null, projectsMode, () => setMode("projects")),
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
    .paddingHorizontal(7)
    .paddingVertical(1)
    .background(C.segTrack)
    .cornerRadius(10);
}

function chevron(collapsed: () => boolean): View {
  return Image("chevron.right")
    .font(10)
    .weight("semibold")
    .color(C.faint)
    .rotation(() => (collapsed() ? 0 : 90))
    .frame({ width: 12, height: 16 });
}

export function laneHeader(laneKey: LaneKey): View {
  const lane = laneByKey(laneKey);
  const target = () => dropLane() === laneKey;
  return HStack({ spacing: 8 }, [
    chevron(() => isCollapsed(lane)),
    RoundedRectangle({ cornerRadius: 3 }).fill(lane.color).frame({ width: 9, height: 9 }),
    Text(lane.name)
      .font(12.5)
      .weight("semibold")
      .color(laneKey === "parked" ? C.faint : C.heading)
      .lineLimit(1)
      .truncation("tail")
      .layoutPriority(1),
    countPill(() => laneCount(laneKey)),
    Spacer(),
    Text(() => (target() ? "Drop here" : ""))
      .font(11)
      .weight("medium")
      .color(C.heading),
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

export function projectHeader(k: string): View {
  const p = projectByKey(k);
  return HStack({ spacing: 8 }, [
    chevron(() => isProjectCollapsed(k)),
    ZStack({}, [
      RoundedRectangle({ cornerRadius: 5 }).fill(p.color),
      Image(p.icon).font(10).weight("semibold").color(glyphColor(p.color, C.text)),
    ]).frame({ width: 18, height: 18 }),
    Text(p.name).font(12.5).weight("semibold").color(C.heading).lineLimit(1).truncation("tail").layoutPriority(1),
    countPill(() => projectCount(k)),
    Spacer(),
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
