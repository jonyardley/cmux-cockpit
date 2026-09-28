// Small pieces shared by the cockpit's cards and rows.

import { glyphColor } from "../../shared/contrast.ts";
import { dismissNeeds, isNeedsDismissed, restoreNeeds } from "../../shared/needs.ts";
import { prChipColors } from "../../shared/pr-colors.ts";
import { PROJECTS, projectId, projectOf } from "../../shared/projects.ts";
import { prSummary } from "../../shared/prs.ts";
import { displayTitle } from "../../shared/titles.ts";
import { haloDot, when } from "../../shared/ui.ts";
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

// Edge as a filled ring: the edge colour fills an outer rounded box and the
// face sits inset by the edge width. A borderWidth stroke is clipped by the
// corner radius and thins out round every corner. `hug` keeps the face at its
// content width (chips) instead of filling the row.
export function ring(
  view: View,
  face: Reactive<string>,
  edge: Reactive<string>,
  width: Reactive<number>,
  radius: number,
  hug = false,
): View {
  const wv = typeof width === "function" ? width : () => width;
  const inner = view.background(face).cornerRadius(() => radius - wv());
  return VStack({ spacing: 0 }, [hug ? inner : inner.frame({ maxWidth: "infinity" })])
    .padding(wv)
    .background(edge)
    .cornerRadius(radius);
}

// Working and needs dots sit on board 1's soft halo; the rest keep the same
// frame so a lane's rows line up.
export function statusDot(w: WsAccessor, size: number): View {
  // One status per change, read by the fill, the stroke and the halo.
  const info = computed(() => statusInfo(w()));
  const dot = Circle({ size })
    .fill(() => info().dot ?? "clear")
    .stroke(() => (info().dot ? "clear" : C.grey))
    .strokeWidth(1.5);
  return haloDot(dot, () => info().halo, size);
}

export function glyph(w: WsAccessor, size: number, radius: number, font: number): View {
  // computed(), not a plain thunk: fill, icon and glyph colour all read it,
  // so the directory is looked up once per change, not once per reader.
  const project = computed(() => projectOf(w()?.directory));
  return ZStack({}, [
    RoundedRectangle({ cornerRadius: radius }).fill(() => project().color),
    Image(() => project().icon)
      .font(font)
      .weight("semibold")
      .color(() => glyphColor(project().color, C.text)),
  ]).frame({ width: size, height: size });
}

export function unreadBadge(w: WsAccessor, n: () => number = () => w()?.unread ?? 0): View {
  const has = () => n() > 0;
  return Text(() => (has() ? String(n()) : ""))
    .font(10)
    .bold()
    .color("white")
    .paddingHorizontal(() => (has() ? 5 : 0))
    .paddingVertical(() => (has() ? 1 : 0))
    .background(() => (has() ? C.unreadBg : "clear"))
    .cornerRadius(7);
}

// Trailing metadata (PR number, age) never wraps: it keeps its width and the
// title truncates instead.
export function meta(fn: () => string, color: Reactive<string> = C.tertiary): View {
  return Text(fn).font(11).monospaced().color(color).lineLimit(1).layoutPriority(2);
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
    unreadBadge(w, () => badgeCount(w())),
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
// the pieces once; only the text and colours are reactive. The PR chip takes
// its health's colours; the branch and ports chips stay quiet.
function chip(id: ChipId, c: () => Chip): View {
  const isPr = id === "pr";
  const st = () => prChipColors(c().health ?? "quiet", c().status, c().draft);
  const fg = () => (isPr ? st().fg : C.chipText);
  // Monospaced straight after the font, as meta() does, so port digits hold still.
  const sized = Text(() => c().text).font(11);
  const text = (id === "port" ? sized.monospaced() : sized).weight("medium").lineLimit(1).truncation("tail").color(fg);
  const parts: View[] =
    id === "port"
      ? [text]
      : [
          Image(isPr ? "arrow.triangle.pull" : "arrow.branch")
            .font(9)
            .color(fg),
          text,
        ];
  // The uncommitted-changes dot trails the branch name (issue #48).
  if (id === "br")
    parts.push(
      when(
        "dirty",
        () => !!c().dirty,
        () => Circle({ size: 5 }).fill(C.clay),
      ),
    );
  const body = HStack({ spacing: 4 }, parts).paddingHorizontal(6).paddingVertical(1);
  return ring(
    body,
    () => (isPr ? st().bg : C.ground),
    () => (isPr ? st().edge : C.chipEdge),
    1,
    6,
    true,
  ).onTap(() => {
    const url = c().url;
    if (url) openURL(url);
  });
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
  const colors = () => prChipColors(pr()?.health ?? "quiet", pr()?.status, pr()?.draft);
  const chipText = Text(() => pr()?.state ?? "")
    .font(11)
    .weight("medium")
    .lineLimit(1)
    .paddingHorizontal(6)
    .paddingVertical(1)
    .color(() => colors().fg);
  const line = () =>
    HStack({ spacing: 6 }, [
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
      // A PR with no status has no words, so no empty pill.
      when(
        "pr-state",
        () => !!pr()?.state,
        () =>
          ring(
            chipText,
            () => colors().bg,
            () => colors().edge,
            1,
            6,
            true,
          ),
      ).layoutPriority(2),
    ])
      // The tap sits inside the frame, so the free width after the chip
      // still selects the card rather than opening the PR.
      .onTap(() => {
        const url = pr()?.url;
        if (url) openURL(url);
      })
      .frame({ maxWidth: "infinity", alignment: "leading" });
  return when("pr-line", () => !!pr(), line);
}

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
    () => ring(body, C.card, C.chipEdge, 1, 6, true).onTap(() => fileForReview(w())),
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
  ).frame({ maxWidth: "infinity" });
  // Cards keep a 6pt gap; the list spacing is 2pt so rows sit tight.
  return VStack({ spacing: 0 }, [face])
    .paddingBottom(4)
    .frame({ maxWidth: "infinity" })
    .onTap(() => selectWorkspace(w()?.id))
    .contextMenu(cardMenu(w));
}
