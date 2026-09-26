// Small pieces shared by the cockpit's cards and rows.

import { glyphColor } from "../../shared/contrast.ts";
import { dismissNeeds, isNeedsDismissed, restoreNeeds } from "../../shared/needs.ts";
import { projectOf } from "../../shared/projects.ts";
import { displayTitle } from "../../shared/titles.ts";
import { haloDot } from "../../shared/ui.ts";
import { LANES } from "../lanes.ts";
import { isSelected, laneOf, moveToLane, selectWorkspace } from "../model.ts";
import { drag } from "../state.ts";
import { ageOf, statusInfo } from "../status.ts";
import { C } from "../theme.ts";

export type WsAccessor = () => Workspace | undefined;

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
  const dot = Circle({ size })
    .fill(() => statusInfo(w()).dot ?? "clear")
    .stroke(() => (statusInfo(w()).dot ? "clear" : C.grey))
    .strokeWidth(1.5);
  return haloDot(dot, () => statusInfo(w()).halo, size);
}

export function glyph(w: WsAccessor, size: number, radius: number, font: number): View {
  return ZStack({}, [
    RoundedRectangle({ cornerRadius: radius }).fill(() => projectOf(w()?.directory).color),
    Image(() => projectOf(w()?.directory).icon)
      .font(font)
      .weight("semibold")
      .color(() => glyphColor(projectOf(w()?.directory).color)),
  ]).frame({ width: size, height: size });
}

export function unreadBadge(w: WsAccessor): View {
  const n = () => w()?.unread ?? 0;
  const has = () => n() > 0;
  return Text(() => (has() ? String(n()) : ""))
    .font(10)
    .bold()
    .color("white")
    .paddingHorizontal(() => (has() ? 5 : 0))
    .paddingVertical(() => (has() ? 1 : 0))
    .background(() => (has() ? C.clay : "clear"))
    .cornerRadius(7);
}

// Trailing metadata (PR number, age) never wraps: it keeps its width and the
// title truncates instead.
export function meta(fn: () => string, color: string = C.tertiary): View {
  return Text(fn).font(11).monospaced().color(color).lineLimit(1).layoutPriority(2);
}

// Title row shared by the card densities: title takes the slack, badge and
// age hold their width on the right.
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
    unreadBadge(w),
    meta(() => ageOf(w())),
  ]).frame({ maxWidth: "infinity" });
}

export function statusLabel(w: WsAccessor, size: number, weight: Weight): View {
  return Text(() => statusInfo(w()).label)
    .font(size)
    .weight(weight)
    .color(() => statusInfo(w()).text)
    .lineLimit(1)
    .layoutPriority(2);
}

// --- chips ---------------------------------------------------------------------------

interface ChipStyle {
  bg: string;
  fg: string;
  edge: string;
}

const PR_STYLE: Record<PrStatus, ChipStyle> = {
  open: { bg: "#EAF1E4", fg: "#3F5A2C", edge: "#D6E4CB" },
  merged: { bg: "#EFEAF7", fg: "#5B3E91", edge: "#DED4EF" },
  closed: { bg: "#F4F2EA", fg: "#6B6A64", edge: "#E8E5DA" },
};

export interface Chip {
  id: string;
  kind: "pr" | "branch";
  text: string;
  url?: string;
  status?: PrStatus;
}

export function chipsFor(w: Workspace | undefined, withBranch: boolean): Chip[] {
  const out: Chip[] = [];
  if (!w) return out;
  const pr = w.pr;
  if (pr?.number) {
    const c: Chip = { id: "pr", kind: "pr", text: "#" + pr.number + " " + (pr.status || "") };
    if (pr.url) c.url = pr.url;
    if (pr.status) c.status = pr.status;
    out.push(c);
  }
  if (withBranch && w.branch) out.push({ id: "br", kind: "branch", text: w.branch + (w.dirty ? " •" : "") });
  return out;
}

function chip(c: () => Chip): View {
  const st = () => {
    const s = c().status;
    return s ? PR_STYLE[s] : PR_STYLE.closed;
  };
  const isPr = () => c().kind === "pr";
  const body = HStack({ spacing: 4 }, [
    Image(() => (isPr() ? "arrow.triangle.pull" : "arrow.branch"))
      .font(9)
      .color(() => (isPr() ? st().fg : "#4A4945")),
    Text(() => c().text)
      .font(11)
      .weight("medium")
      .lineLimit(1)
      .truncation("middle")
      .color(() => (isPr() ? st().fg : "#4A4945")),
  ])
    .paddingHorizontal(6)
    .paddingVertical(1);
  return ring(
    body,
    () => (isPr() ? st().bg : C.ground),
    () => (isPr() ? st().edge : "#E8E5DA"),
    1,
    6,
    true,
  ).onTap(() => {
    const url = c().url;
    if (url) openURL(url);
  });
}

export function chipsRow(w: WsAccessor, withBranch: boolean): View {
  return HStack({ spacing: 5 }, [
    ForEach({ items: () => chipsFor(w(), withBranch), key: (c) => c.id }, (c) => chip(c)),
    Spacer({ minLength: 0 }),
  ]);
}

// --- card chrome and menu ------------------------------------------------------------

function workspaceAction(w: Workspace | undefined, action: string): void {
  if (w) cmux("workspace.action", { action, workspace_id: w.id });
}

export function cardMenu(w: WsAccessor): MenuItem[] {
  const laneItems = LANES.map((lane) =>
    Button(
      () => (laneOf(w() ?? { id: "" }) === lane.key ? "✓ " + lane.name : lane.name),
      () => moveToLane(w(), lane.key),
    ),
  );
  return [
    Menu("Move to", laneItems),
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

// White card, hairline edge, clay outline when selected or dragged.
export function cardChrome(view: View, w: WsAccessor, key: string, radius: number): View {
  const lit = () => drag()?.id === key || isSelected(w());
  const face = ring(
    view,
    C.card,
    () => (lit() ? C.clay : C.cardEdge),
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
