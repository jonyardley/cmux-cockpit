// Small pieces shared by the cockpit's cards and rows.

import type { MoveSize } from "../../shared/move.ts";
import { dismissNeeds, isNeedsDismissed, restoreNeeds } from "../../shared/needs.ts";
import { NEUTRAL_CHIP, prChipColors, prInk } from "../../shared/pr-colors.ts";
import { PROJECTS, projectId, projectOf } from "../../shared/projects.ts";
import { prSummary } from "../../shared/prs.ts";
import { displayTitle } from "../../shared/titles.ts";
import {
  branchText,
  chipFrame,
  chipHover,
  chipText,
  haloDot,
  linkBox,
  meta,
  openIfUrl,
  outMark,
  projectBadge,
  ring,
  unreadBadge,
  when,
} from "../../shared/ui.ts";
import { showsChipsRow } from "../chips.ts";
import { LANES } from "../lanes.ts";
import {
  type Chip,
  type ChipId,
  canCreateProject,
  canFileForReview,
  chipsFor,
  clearProjectOverride,
  createProjectFrom,
  cycleProjectColor,
  cycleProjectIcon,
  fileForReview,
  hasProjectOverride,
  inAppProjectName,
  laneOf,
  moveToLane,
  moveToProject,
  newSessionFor,
  newSessionLabel,
  projectKey,
  removeProject,
} from "../model.ts";
import { drag, isSelected, selectWorkspace } from "../state.ts";
import { ageOf, badgeCount, isReady, statusInfo, statusLine } from "../status.ts";
import { C } from "../theme.ts";

export type WsAccessor = () => Workspace | undefined;

// A quiet glyph, not a chip: for a control that sits inside a row or header
// which already has its own edge and its own onTap. The shape gives the tap
// a full frame-sized target (a framed Image only takes taps on its glyph),
// and its own onTap keeps it independent of the parent's tap.
export function glyphButton(icon: string, size: number, fontSize: number, color: string, onTap: () => void): View {
  return ZStack({}, [Circle({ size }).fill("clear"), Image(icon).font(fontSize).weight("semibold").color(color)])
    .frame({ width: size, height: size })
    .cornerRadius(size / 2)
    .hoverBackground(C.hover)
    .onTap(onTap);
}

// Working and needs dots sit on board 1's soft halo; the rest keep the same
// frame so a lane's rows line up.
export function statusDot(w: WsAccessor, size: number): View {
  // One status per change, read by the fill, the stroke and the halo.
  const info = computed(() => statusInfo(w()));
  const dot = Circle({ size })
    .fill(() => info().dot ?? "clear")
    .stroke(() => (info().dot ? "clear" : (info().ring ?? C.grey)))
    .strokeWidth(1.5);
  return haloDot(dot, () => info().halo, size);
}

export function glyph(w: WsAccessor, size: number, radius: number, font: number): View {
  // computed(), not a plain thunk: fill, icon and glyph colour all read it,
  // so the directory is looked up once per change, not once per reader.
  return projectBadge(
    computed(() => projectOf(w()?.directory)),
    size,
    font,
    radius,
  );
}

// The green "Ready" pill (issue #53): the agent finished while Jon was
// elsewhere. It stands in for the unread badge, and clears once he opens
// the workspace. Behind a when(), so it takes no slot otherwise.
function readyPill(w: WsAccessor): View {
  return when(
    "ready",
    () => isReady(w()),
    () =>
      Text("Ready")
        .font(10.5)
        .weight("medium")
        .color(C.greenText)
        .lineLimit(1)
        .paddingHorizontal(7)
        .paddingVertical(1)
        .background(C.readyBg)
        .cornerRadius(8),
  ).layoutPriority(2);
}

// Title row shared by the card densities: title takes the slack, pill or
// badge and age hold their width on the right.
export function titleRow(w: WsAccessor, size: number): View {
  return HStack({ spacing: 6 }, [
    Text(() => displayTitle(w()))
      .font(size)
      .weight("semibold")
      .color(C.text)
      .lineLimit(1)
      .truncation("middle")
      .layoutPriority(1),
    Spacer({ minLength: 4 }),
    readyPill(w),
    unreadBadge(() => badgeCount(w())),
    meta(() => ageOf(w())),
  ]).frame({ maxWidth: "infinity" });
}

// The status and how long it has held ("Working 14m", issue #47).
export function statusLabel(w: WsAccessor, size: number, weight: Weight): View {
  return Text(() => statusLine(w()))
    .font(size)
    .weight(weight)
    .color(() => statusInfo(w()).text)
    .lineLimit(1)
    .layoutPriority(2);
}

// --- chips ---------------------------------------------------------------------------

// A chip's kind is fixed by its key (one when() per id), so the kind picks
// the pieces once; only the text and colours are reactive. The PR chip is
// words in its health's colour; the branch and ports chips stay neutral pills.
// The size chip (what answering the chat takes): the quiet chip's face, its
// words in the state ink that fits, and nothing to tap, like the branch chip.
const SIZE_INK: Record<MoveSize, string> = { quick: C.greenText, decide: C.clayText, review: C.blueText };

function sizeChip(c: () => Chip): View {
  const colors = () => ({ ...NEUTRAL_CHIP, fg: SIZE_INK[c().size ?? "quick"] });
  return chipFrame(
    chipText(
      () => c().text,
      () => colors().fg,
      false,
    ),
    colors,
  );
}

function chip(id: ChipId, c: () => Chip): View {
  if (id === "size") return sizeChip(c);
  const isPr = id === "pr";
  const colors = () => (isPr ? prChipColors(c().health ?? "quiet") : NEUTRAL_CHIP);
  const fg = () => colors().fg;
  const text = id === "br" ? branchText(() => c().text, fg, "medium") : chipText(() => c().text, fg, id === "port");
  // The PR chip's glyph turns into ↗ under the pointer, in the same slot,
  // so the chip keeps its width. The port chip's words already end in ↗.
  const icon = (name: string): View => Image(name).font(9).color(fg);
  const live = () => !!c().url;
  const lead = isPr
    ? ZStack({}, [icon("arrow.triangle.pull").hideOnHover(live), outMark(fg, live)])
    : icon("arrow.branch");
  const parts: View[] = id === "port" ? [text] : [lead, text];
  // The uncommitted-changes dot trails the branch name (issue #48).
  if (id === "br")
    parts.push(
      when(
        "dirty",
        () => !!c().dirty,
        () => Circle({ size: 5 }).fill(C.secondary),
      ),
    );
  const body = HStack({ spacing: 4 }, parts);
  // The branch chip opens nothing, so it has no hover and no tap of its
  // own: a click on it selects the card, as the card's free space does.
  if (id === "br") return chipFrame(body, colors);
  return chipFrame(body, colors, chipHover(colors, live)).onTap(() => openIfUrl(c().url));
}

/** The chip with `id` from a `chipsFor` list, or an empty one while it is absent. */
function chipById(chips: readonly Chip[], id: ChipId): Chip {
  return chips.find((c) => c.id === id) ?? { id, text: "" };
}

// The full card's PR line under its status (issue #73): the number, the
// PR's own title, which is the part that gives way, then a chip with its
// worst state (issue #72). Behind a when(), so a card with no PR has no line.
export function prLine(w: WsAccessor, size: number): View {
  const pr = computed(() => prSummary(w()));

  // The frame goes on a wrapper: on the link's own node it would stretch
  // the tap and hover across the free width, which should select the card.
  const line = () =>
    VStack({ spacing: 0 }, [
      linkBox(
        [
          meta(() => pr()?.tag ?? "", C.secondary),
          when(
            "pr-title",
            () => !!pr()?.title,
            () =>
              Text(() => pr()?.title ?? "")
                .font(size)
                .color(C.secondary)
                .lineLimit(1)
                .truncation("tail"),
          ),
          // A PR with no status has no words.
          when(
            "pr-state",
            () => !!pr()?.state,
            () =>
              chipText(
                () => pr()?.state ?? "",
                () => prInk(pr()?.health ?? "quiet"),
              ),
          ).layoutPriority(2),
        ],
        C.secondary,
        () => pr()?.url,
      ),
    ]).frame({ maxWidth: "infinity", alignment: "leading" });
  return when("pr-line", () => !!pr(), line);
}

// "To review →" is a white chip with the quiet chip's edge.
const REVIEW_CHIP = { ...NEUTRAL_CHIP, bg: C.card };

// "To review →" on a Ready card: files it into For review (issue #53). A
// quiet chip with its own onTap, so the tap never also selects the card.
export function toReviewAction(w: WsAccessor): View {
  const body = Text("To review →")
    .font(11)
    .weight("medium")
    .color(C.secondary)
    .lineLimit(1)
    .paddingHorizontal(7)
    .paddingVertical(1);
  return when(
    "to-review",
    () => canFileForReview(w()),
    () =>
      ring(body, REVIEW_CHIP.bg, REVIEW_CHIP.edge, 1, 6, { hug: true, hover: chipHover(() => REVIEW_CHIP) }).onTap(() =>
        fileForReview(w()),
      ),
  ).layoutPriority(2);
}

// One when() per chip, so each has a fixed key and its own place in the
// HStack. The PR and ports chips are short and say the most, so they hold
// their width and the branch chip gives way, cut at its end. The priority
// sits on the when() result because a priority inside it does not reach the
// HStack. No Spacer: it is flexible too and would split the free width with
// the branch chip, so the frame left-aligns instead.
export function chipsRow(w: WsAccessor, withBranch: boolean, withPr = true): View {
  // One chip list per change, read by every predicate and chip below.
  const chips = computed(() => chipsFor(w(), withBranch));
  const one = (id: ChipId) =>
    when(
      id,
      () => chips().some((c) => c.id === id),
      () => chip(id, () => chipById(chips(), id)),
    );
  // The full card puts its PR on a line of its own (prLine), so it leaves the chip out.
  const row = () =>
    HStack({ spacing: 5 }, [
      one("size").layoutPriority(2),
      ...(withPr ? [one("pr").layoutPriority(2)] : []),
      one("br"),
      one("port").layoutPriority(2),
      toReviewAction(w),
    ]).frame({
      maxWidth: "infinity",
      alignment: "leading",
    });
  // Behind a when(), so a card with nothing to show has no empty row and no
  // gap above it (issue #79).
  return when("chips-row", () => showsChipsRow(chips(), w(), withPr), row);
}

// --- card chrome and menu ------------------------------------------------------------

function workspaceAction(w: Workspace | undefined, action: string): void {
  if (w) cmux("workspace.action", { action, workspace_id: w.id });
}

// cmux drops Menu() submenus from a context menu without a word, so every
// item sits at the top level, grouped by dividers and prefixed by what it
// moves. The project override persists through the state loop (issue #8).
function laneItems(w: WsAccessor): MenuItem[] {
  return LANES.map((lane) =>
    Button(
      () => (laneOf(w() ?? { id: "" }) === lane.key ? "✓ " : "") + "Lane: " + lane.name,
      () => moveToLane(w(), lane.key),
    ),
  );
}

function projectItems(w: WsAccessor): MenuItem[] {
  const items = PROJECTS.map((p) => {
    const key = projectId(p);
    return Button(
      () => (projectKey(w() ?? { id: "" }) === key ? "✓ " : "") + "Project: " + p.name,
      () => moveToProject(w(), key),
    );
  });
  return [
    ...items,
    Button(
      () => (hasProjectOverride(w()) ? "Clear project override" : "No project override set"),
      () => clearProjectOverride(w()),
    ),
  ];
}

// Projects made in the sidebar (issue #9). The menu's items are fixed when the
// card is built, so an item that does not apply says why instead of vanishing.
function inAppProjectItems(w: WsAccessor): MenuItem[] {
  const named = (verb: string) => () => {
    const name = inAppProjectName(w());
    return name ? `${verb}: ${name}` : `${verb} (sidebar-made projects only)`;
  };
  return [
    Button(
      () => (canCreateProject(w()) ? "New project from this folder" : "New project (folder has one, or none)"),
      () => createProjectFrom(w()),
    ),
    Button(named("Next colour"), () => cycleProjectColor(w())),
    Button(named("Next icon"), () => cycleProjectIcon(w())),
    Button(named("Remove project"), () => removeProject(w())),
  ];
}

export function cardMenu(w: WsAccessor): MenuItem[] {
  return [
    Button(
      () => newSessionLabel(w()),
      () => newSessionFor(w()),
    ),
    Divider(),
    ...laneItems(w),
    Divider(),
    ...projectItems(w),
    Divider(),
    ...inAppProjectItems(w),
    Divider(),
    Button(
      () => (w()?.pinned ? "Unpin" : "Pin"),
      () => workspaceAction(w(), w()?.pinned ? "unpin" : "pin"),
    ),
    Button("Mark read", () => workspaceAction(w(), "mark_read")),
    Button(
      () => (isNeedsDismissed(w()) ? "Restore needs you" : "Dismiss needs you"),
      () => (isNeedsDismissed(w()) ? restoreNeeds(w()) : dismissNeeds(w())),
    ),
  ];
}

// White card, hairline edge, ink outline when selected or dragged.
export function cardChrome(view: View, w: WsAccessor, key: string, radius: number): View {
  const lit = () => drag()?.id === key || isSelected(w());
  const face = ring(
    view,
    C.card,
    () => (lit() ? C.select : C.cardEdge),
    () => (lit() ? 1.5 : 1),
    radius,
    { hover: { face: C.cardHover } },
  ).frame({ maxWidth: "infinity" });
  // Cards keep a 6pt gap; the list spacing is 2pt so rows sit tight.
  return VStack({ spacing: 0 }, [face])
    .paddingBottom(4)
    .frame({ maxWidth: "infinity" })
    .onTap(() => selectWorkspace(w()?.id))
    .contextMenu(cardMenu(w));
}
