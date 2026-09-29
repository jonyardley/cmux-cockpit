// The segmented mode control and the lane and project section headers.

import { isProjectKey } from "../../shared/projects.ts";
import { countPill, laneTitle, projectBadge, ring, sectionTitle, unreadBadge, when } from "../../shared/ui.ts";
import { dropLane } from "../drop.ts";
import { editLabel, openEditor } from "../edit.ts";
import { type LaneKey, laneByKey } from "../lanes.ts";
import {
  canOpenProject,
  chooseMode,
  headerHint,
  isCollapsed,
  isProjectCollapsed,
  laneWorkspaces,
  openProjectWorkspace,
  projectByKey,
  projectNewLabel,
  projectWorkspaces,
  quietLabel,
  quietProjects,
  toggleLane,
  toggleProject,
  toggleQuiet,
  wsById,
} from "../model.ts";
import { isMode, isSelected, projectsMode, quietCollapsed, selectWorkspace } from "../state.ts";
import { headerStatus } from "../status.ts";
import { C } from "../theme.ts";
import { glyphButton, statusDot } from "./parts.ts";

function segButton(label: string, icon: string | null, on: () => boolean, set: () => void): View {
  return (
    ZStack({}, [
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
      // Behind the face, so only the segment that is not chosen lights. The
      // clear background makes the renderer round its fill instead of
      // clipping the node, which would cut the chosen face's stroke.
      .background("clear")
      .hoverBackground(C.hover)
      .cornerRadius(7)
      .onTap(set)
  );
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

// A lane's, the empty lane's and Quiet's heading: small capitals, which
// win the row's width and truncate rather than wrap, as laneTitle does.
const laneHeading = (name: string, color: string): View =>
  sectionTitle(name.toUpperCase(), color).truncation("tail").layoutPriority(1);

// A header's count pill over its cards, then, while it is folded, the dot of
// its most urgent session, so a folded header still says what is live under
// it. One filter and one status (status.ts headerStatus) per change, read by
// the count, the tint and the dot.
function cardsCount(cards: () => Workspace[], folded: () => boolean): View[] {
  const list = computed(cards);
  const shown = computed(() => headerStatus(list(), folded()));
  return [
    countPill(
      () => String(list().length),
      () => shown().tint,
    ),
    when(
      "folded-dot",
      () => shown().dot !== undefined,
      () => statusDot(() => shown().dot, 7),
    ),
  ];
}

const CHEVRON_SLOT = { width: 12, height: 16 } as const;

function chevron(collapsed: () => boolean): View {
  return Image("chevron.right")
    .font(10)
    .weight("semibold")
    .color(C.faint)
    .rotation(() => (collapsed() ? 0 : 90))
    .frame(CHEVRON_SLOT);
}

// A lane's generated anchor with an agent or unread messages (issue #49): its
// dot and unread count sit on the header, shaded while it is selected, since
// it has no card to carry the selection. Its own onTap selects it rather
// than folding the lane, as the project header's "+" does.
function anchorStatus(anchorId: string): View {
  const w = () => wsById(anchorId);
  return HStack({ spacing: 5 }, [statusDot(w, 7), unreadBadge(() => w()?.unread ?? 0)])
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

// A lane header's trailing words: "Drop here" under a drag, else how many
// of its PRs are ready to merge (model.ts's headerHint). One Text, so an
// empty one leaves no spacing slot and both sit flush right.
function laneHint(laneKey: LaneKey, target: () => boolean): View {
  const hint = computed(() => headerHint(laneKey, target()));
  return Text(() => hint().text)
    .font(11)
    .weight(() => (target() ? "medium" : "regular"))
    .color(() => hint().color)
    .lineLimit(1);
}

// A header sits SECTION_GAP below the section above. The gap goes on a wrapper outside the hover and drop
// shading, so the grey hugs the row; the tap stays on the wrapper, as on
// cards, so the gap still folds the header.
const SECTION_GAP = 14;
const HEADER_PAD = 5;
const headerGap = (row: View, tap?: () => void): View => {
  const gap = VStack({ spacing: 0 }, [row])
    .paddingTop(SECTION_GAP - HEADER_PAD)
    .frame({ maxWidth: "infinity" });
  return tap ? gap.onTap(tap) : gap;
};

const laneMarker = (color: string): View =>
  RoundedRectangle({ cornerRadius: 3 }).fill(color).frame({ width: 9, height: 9 });

export function laneHeader(laneKey: LaneKey, anchorId: string | null): View {
  const lane = laneByKey(laneKey);
  const target = () => dropLane() === laneKey;
  const row = HStack({ spacing: 8 }, [
    chevron(() => isCollapsed(lane)),
    laneMarker(lane.color),
    laneHeading(lane.name, laneKey === "parked" ? C.faint : C.secondary),
    ...(anchorId ? [anchorStatus(anchorId)] : []),
    ...cardsCount(
      () => laneWorkspaces(laneKey),
      () => isCollapsed(lane),
    ),
    Spacer({ minLength: 4 }),
    laneHint(laneKey, target),
  ])
    .paddingHorizontal(8)
    .paddingVertical(HEADER_PAD)
    .cornerRadius(8)
    .background(() => (target() ? C.dropTarget : "clear"))
    .hoverBackground(() => (target() ? C.dropTarget : C.hover))
    .frame({ maxWidth: "infinity" });
  return headerGap(row, () => toggleLane(lane)).fixed();
}

// An empty lane (issues #50 and #75): drawn like a lane header, with the
// same chevron slot, name position, padding and count, only fainter, and no
// box at rest. It has nothing to fold, so no tap. It stays a drop target.
// Under the pointer it gets a face and an ink edge, but that waits on
// cmux's drag events (onDragChange), which arrive in 0.65.0: on 0.64.25 it
// never lights. The ring is always ZONE_EDGE wide, clear at rest, and the
// row's padding gives that width back, so the name sits where a header's
// does whether or not it is lit.
const ZONE_EDGE = 1;
const EMPTY_FADE = 0.55;

export function dropZone(laneKey: LaneKey): View {
  const lane = laneByKey(laneKey);
  const target = () => dropLane() === laneKey;
  const row = HStack({ spacing: 8 }, [
    Spacer({ minLength: 0 }).frame(CHEVRON_SLOT),
    laneMarker(lane.color).opacity(EMPTY_FADE),
    laneHeading(lane.name, C.faint),
    countPill(() => "0").opacity(EMPTY_FADE),
    Spacer({ minLength: 4 }),
    dropHint(target),
  ])
    .paddingHorizontal(8 - ZONE_EDGE)
    .paddingVertical(HEADER_PAD - ZONE_EDGE);
  const zone = ring(
    row,
    () => (target() ? C.zoneLit : "clear"),
    () => (target() ? C.heading : "clear"),
    ZONE_EDGE,
    8,
  );
  return headerGap(zone).fixed();
}

const badge = (k: string, size: number, font: number): View => {
  const p = projectByKey(k);
  return projectBadge(() => p, size, font);
};

// Projects with no sessions (issue #54): a muted header that folds, then a
// short row each, so the busy projects stand out and the quiet ones still
// have names. The renderer has no hover-only views, so the row's plus is a
// faint glyph at rest and the whole row is the button.
export function quietHeader(): View {
  const row = HStack({ spacing: 8 }, [
    chevron(quietCollapsed),
    laneHeading("Quiet", C.faint),
    countPill(() => String(quietProjects().length)),
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
    laneTitle(projectByKey(k).name, C.secondary, "regular"),
    Spacer({ minLength: 4 }),
    ...(open ? [Image("plus").font(10).weight("semibold").color(C.faint)] : []),
  ])
    .paddingHorizontal(8)
    .paddingVertical(3)
    .cornerRadius(7)
    .frame({ maxWidth: "infinity" })
    .contextMenu([
      Button(quietLabel(k), () => openProjectWorkspace(k)),
      Divider(),
      Button(editLabel(k), () => openEditor(k)),
    ]);
  if (!open) return row.opacity(0.55);
  return row.hoverBackground(C.hover).onTap(() => openProjectWorkspace(k));
}

// A project's own menu: open a session in it, or edit it. Other has no edit.
const projectMenu = (k: string): MenuItem[] => [
  Button(projectNewLabel(k), () => openProjectWorkspace(k)),
  ...(isProjectKey(k) ? [Divider(), Button(editLabel(k), () => openEditor(k))] : []),
];

export function projectHeader(k: string): View {
  const p = projectByKey(k);
  const row = HStack({ spacing: 8 }, [
    chevron(() => isProjectCollapsed(k)),
    badge(k, 18, 10),
    laneTitle(p.name, C.heading),
    ...cardsCount(
      () => projectWorkspaces(k),
      () => isProjectCollapsed(k),
    ),
    Spacer({ minLength: 4 }),
    ...(canOpenProject(k) ? [glyphButton("plus", 20, 11, C.secondary, () => openProjectWorkspace(k))] : []),
  ])
    .paddingHorizontal(8)
    .paddingVertical(HEADER_PAD)
    .cornerRadius(8)
    .hoverBackground(C.hover)
    .frame({ maxWidth: "infinity" })
    .contextMenu(projectMenu(k));
  return headerGap(row, () => toggleProject(k));
}
