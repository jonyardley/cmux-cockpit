// Small pieces shared by the cockpit's cards and rows.

import type { MoveSize } from "../../shared/move.ts";
import { isNeedsDismissed, restoreNeeds } from "../../shared/needs.ts";
import { type ChipColors, NEUTRAL_CHIP, prInk } from "../../shared/pr-colors.ts";
import { PROJECTS, projectId } from "../../shared/projects.ts";
import { prSummary } from "../../shared/prs.ts";
import { displayTitle } from "../../shared/titles.ts";
import {
  branchText,
  chipFrame,
  chipHover,
  chipText,
  haloDot,
  meta,
  openIfUrl,
  outMark,
  projectBadge,
  ring,
  unreadBadge,
  when,
} from "../../shared/ui.ts";
import {
  canCreateProject,
  clearProjectOverride,
  createProjectFrom,
  hasProjectOverride,
  makeProjectLabel,
  moveToProject,
  newSessionFor,
  newSessionLabel,
  projectKey,
  projectOfWorkspace,
} from "../by-project.ts";
import { type Chip, type ChipId, chipsFor, type PrChip, type TextChip } from "../card-chips.ts";
import { chipsSplit } from "../chips.ts";
import { LANES } from "../lanes.ts";
import { cardOpacity } from "../merged.ts";
import { laneOf, moveToLane } from "../model.ts";
import { drag, isSelected, selectWorkspace } from "../state.ts";
import {
  ageOf,
  badgeCount,
  isReady,
  OUTLINE_MAX,
  openPrLabel,
  outline,
  statusHasAge,
  statusInfo,
  statusLine,
} from "../status.ts";
import { dismissWaiting } from "../strip.ts";
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
  // so the project is looked up once per change, not once per reader.
  return projectBadge(
    computed(() => projectOfWorkspace(w())),
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

// The pin at the far right of a pinned workspace's title row: faint, so it
// reads as a property, never a state. Behind a when(), so it takes no slot
// otherwise. No layout priority: an image cannot shrink, and the title keeps
// first claim on the width. Not a control: unpinning stays in the menu.
export function pinMark(w: WsAccessor): View {
  return when(
    "pinned",
    () => !!w()?.pinned,
    () => Image("pin.fill").font(9.5).color(C.faint),
  );
}

// Title row shared by the cards and the Projects row: title takes the
// slack, pill or badge and age hold their width on the right. The age shows
// only while the status line under it has no time, so one card never reads
// two.
export function titleRow(w: WsAccessor, size: number, lines = 1): View {
  // Over two lines, the pills and age sit by the first; one line keeps the default.
  return HStack(lines > 1 ? { spacing: 6, alignment: "top" } : { spacing: 6 }, [
    Text(() => displayTitle(w()))
      .font(size)
      .weight("semibold")
      .color(C.text)
      .lineLimit(lines)
      // One line keeps both ends; over more lines the end is what gets cut.
      .truncation(lines > 1 ? "tail" : "middle")
      .layoutPriority(1),
    Spacer({ minLength: 4 }),
    readyPill(w),
    unreadBadge(() => badgeCount(w())),
    // On the when() result: the priority inside meta() does not reach this HStack.
    when(
      "title-age",
      () => !statusHasAge(w()),
      () => meta(() => ageOf(w())),
    ).layoutPriority(2),
    pinMark(w),
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
// the pieces once; only the text and colours are reactive. Every chip is the
// quiet pill: the PR's number in the chip's ink, then its state in its
// health's; the branch and ports chips in the chip's ink alone.
// The size chip (what answering the chat takes): the quiet chip's face, its
// words in the state ink that fits, and nothing to tap, like the branch chip.
const SIZE_INK: Record<MoveSize, string> = { quick: C.greenText, decide: C.clayText, review: C.blueText };

function sizeChip(c: () => TextChip): View {
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

const quietChip = (): ChipColors => NEUTRAL_CHIP;

/** Whether a PR chip opens its PR on a tap, or stays still so a click on it selects the card. */
export type PrTap = "opens" | "still";

// The PR chip (the design refinement's one chip): its glyph, "#135" in
// medium, then "draft" or "1 failing" in regular in its health's ink. Where
// it opens the PR, the glyph turns into ↗ under the pointer, in the same
// slot, so the chip keeps its width.
function prChip(c: () => PrChip, tap: PrTap): View {
  const fg = () => NEUTRAL_CHIP.fg;
  const words = [
    // The number holds its width as the state words do, so "#130" is never cut.
    chipText(() => c().tag, fg).layoutPriority(2),
    // A PR with no state words has no second text, and no gap for it.
    when(
      "pr-state",
      () => !!c().state,
      () =>
        chipText(
          () => c().state,
          () => prInk(c().health),
          false,
          "regular",
        ),
    ).layoutPriority(2),
  ];
  const glyph = Image("arrow.triangle.pull").font(9).color(fg);
  // The full card's PR has no tap of its own (issue #72): a click on it
  // selects the card, and the card menu's Open PR opens it. So no hover and
  // no ↗, as the branch chip.
  if (tap === "still") return chipFrame(HStack({ spacing: 4 }, [glyph, ...words]), quietChip);
  const live = () => !!c().url;
  const body = HStack({ spacing: 4 }, [ZStack({}, [glyph.hideOnHover(live), outMark(fg, live)]), ...words]);
  return chipFrame(body, quietChip, chipHover(quietChip, live)).onTap(() => openIfUrl(c().url));
}

function chip(id: TextChip["id"], c: () => TextChip): View {
  if (id === "size") return sizeChip(c);
  const fg = () => NEUTRAL_CHIP.fg;
  const text = id === "br" ? branchText(() => c().text, fg, "medium") : chipText(() => c().text, fg, true);
  // The port chip's words already end in ↗.
  const parts: View[] = id === "port" ? [text] : [Image("arrow.branch").font(9).color(fg), text];
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
  if (id === "br") return chipFrame(body, quietChip);
  const live = () => !!c().url;
  return chipFrame(body, quietChip, chipHover(quietChip, live)).onTap(() => openIfUrl(c().url));
}

/** The chip with `id` from a `chipsFor` list, or an empty one while it is absent. */
function chipById(chips: readonly Chip[], id: TextChip["id"]): TextChip {
  for (const c of chips) if (c.id !== "pr" && c.id === id) return c;
  return { id, text: "" };
}

const NO_PR: PrChip = { id: "pr", tag: "", state: "", health: "quiet", diff: "" };

/** The PR chip from a `chipsFor` list, or an empty one while it is absent. */
function prById(chips: readonly Chip[]): PrChip {
  for (const c of chips) if (c.id === "pr") return c;
  return NO_PR;
}

// A card's quiet action: a white chip with the quiet chip's edge.
const ACTION_CHIP: ChipColors = { ...NEUTRAL_CHIP, bg: C.card };

// A card's action chip, with its own onTap, so the tap never also selects
// the card.
function actionChip(label: Reactive<string>, tap: () => void): View {
  const body = Text(label)
    .font(11)
    .weight("medium")
    .color(ACTION_CHIP.fg)
    .lineLimit(1)
    .paddingHorizontal(7)
    .paddingVertical(1);
  return ring(body, ACTION_CHIP.bg, ACTION_CHIP.edge, 1, 6, { hug: true, hover: chipHover(() => ACTION_CHIP) }).onTap(
    tap,
  );
}

/** Under Other, a card whose folder can become a project offers it: the card menu's item, in view. */
export function makeProjectAction(w: WsAccessor, top = 0): View {
  return when(
    "make-project",
    () => canCreateProject(w()),
    () =>
      HStack({ spacing: 0 }, [
        actionChip(
          () => makeProjectLabel(w()),
          () => createProjectFrom(w()),
        ),
      ])
        .paddingTop(top)
        .frame({ maxWidth: "infinity", alignment: "leading" }),
  );
}

// One when() per chip, so each has a fixed key and its own place in the
// HStack. The PR and ports chips are short and say the most, so they hold
// their width and the branch chip gives way, cut at its end. The priority
// sits on the when() result because a priority inside it does not reach the
// HStack. No Spacer: it is flexible too and would split the free width with
// the branch chip, so the frame left-aligns instead.
// `prTap` is "still" on the full card, whose PR opens from the card menu.
// `lineChars` is the card's line in characters (chips.ts).
export function chipsRow(w: WsAccessor, withBranch: boolean, prTap: PrTap, lineChars: number): View {
  // One chip list per change, read by every predicate and chip below.
  const chips = computed(() => chipsFor(w(), withBranch));
  const one = (id: ChipId) =>
    when(
      id,
      () => chips().some((c) => c.id === id),
      () => (id === "pr" ? prChip(() => prById(chips()), prTap) : chip(id, () => chipById(chips(), id))),
    );
  const prLine = () => [
    one("size").layoutPriority(2),
    one("pr").layoutPriority(2),
    // The PR's diff size beside its chip, faint and unframed. Outside the
    // chip and below the branch's priority, so on a narrow card it is cut
    // first and the branch keeps its width (issue #152).
    when(
      "pr-diff",
      () => !!prById(chips()).diff,
      () =>
        chipText(
          () => prById(chips()).diff,
          () => C.faint,
          false,
          "regular",
        ),
    ).layoutPriority(-1),
  ];
  const branchLine = () => [one("br"), one("port").layoutPriority(2)];
  const line = (views: View[]) => HStack({ spacing: 5 }, views).frame({ maxWidth: "infinity", alignment: "leading" });
  // Split, the branch goes under the PR when the two do not fit side by
  // side, so a narrow card shows both whole. Worked out once per change.
  const splits = computed(() => chipsSplit(chips(), lineChars));
  const row = () =>
    VStack({ spacing: 0 }, [
      when("chips-split", splits, () =>
        VStack({ alignment: "leading", spacing: 4 }, [line(prLine()), line(branchLine())]),
      ),
      when(
        "chips-one",
        () => !splits(),
        () => line([...prLine(), ...branchLine()]),
      ),
    ]).frame({ maxWidth: "infinity", alignment: "leading" });
  // Behind a when(), so a card with nothing to show has no empty row and no
  // gap above it (issue #79).
  return when("chips-row", () => chips().length > 0, row);
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

// Only making a project lives on the card; editing one is on its header.
const newProjectItem = (w: WsAccessor): MenuItem =>
  Button(
    () => (canCreateProject(w()) ? "New project from this folder" : "New project (folder has one, or none)"),
    () => createProjectFrom(w()),
  );

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
    newProjectItem(w),
    Divider(),
    Button(
      () => (w()?.pinned ? "Unpin" : "Pin"),
      () => workspaceAction(w(), w()?.pinned ? "unpin" : "pin"),
    ),
    Button("Mark read", () => workspaceAction(w(), "mark_read")),
    Button(
      () => openPrLabel(prSummary(w())),
      () => openIfUrl(prSummary(w())?.url),
    ),
    Button(
      () => (isNeedsDismissed(w()) ? "Restore needs you" : "Dismiss needs you"),
      () => (isNeedsDismissed(w()) ? restoreNeeds(w()) : dismissWaiting(w())),
    ),
  ];
}

// White card, hairline edge, and outline()'s ink when selected or dragged.
export function cardChrome(view: View, w: WsAccessor, key: string, radius: number): View {
  const dragged = () => drag()?.id === key;
  const lit = () => dragged() || isSelected(w());
  const edge = computed(() => outline(isSelected(w()), dragged(), C.cardEdge));
  const face = ring(
    view,
    C.card,
    () => edge().color,
    () => edge().width,
    radius,
    {
      hover: { face: C.cardHover },
      steady: OUTLINE_MAX,
    },
  )
    .opacity(() => cardOpacity(w(), lit()))
    .frame({ maxWidth: "infinity" });
  // Cards keep a 6pt gap; the list spacing is 2pt so rows sit tight.
  return VStack({ spacing: 0 }, [face])
    .paddingBottom(4)
    .frame({ maxWidth: "infinity" })
    .onTap(() => selectWorkspace(w()?.id))
    .contextMenu(cardMenu(w));
}
