// Rows for the Waiting, Running and Pull requests panels.

import type { Last } from "../../shared/list.ts";
import { readable } from "../../shared/text.ts";
import { displayTitle } from "../../shared/titles.ts";
import { when } from "../../shared/ui.ts";
import {
  type AgentEntry,
  ageSince,
  idleOpen,
  type PrEntry,
  type RosterRow,
  setIdleOpen,
  statusLine,
  waitingText,
} from "../model.ts";
import { chipColors, T } from "../theme.ts";
import { emptyRow, glyph, idleRing, jump, meta, openIfUrl, ring, ruled, statusDot } from "./parts.ts";

export function waitingRow(e: () => Last<AgentEntry>): View {
  const w = () => e().ws;
  const a = () => e().a;
  const row = VStack({ spacing: 6, alignment: "leading" }, [
    HStack({ spacing: 8 }, [
      glyph(e().project),
      Text(() => displayTitle(w()) || "untitled")
        .font(11.5)
        .color("#6B6A64")
        .lineLimit(1)
        .truncation("middle")
        .layoutPriority(1),
      Spacer({ minLength: 4 }),
      meta(() => ageSince(a().sinceEpoch)),
    ]).frame({ maxWidth: "infinity" }),
    Text(() => waitingText(w()))
      .font(13)
      .color(T.text)
      .lineLimit(3)
      .truncation("tail")
      .frame({ maxWidth: "infinity", alignment: "leading" }),
    HStack({ spacing: 6 }, [
      ring(
        Text("Jump to answer")
          .font(12)
          .weight("medium")
          .color("#3D3D3A")
          .paddingHorizontal(10)
          .paddingVertical(4)
          .hoverBackground("#F4F2EA"),
        T.panel,
        "#E2DFD3",
        1,
        8,
        true,
      ).onTap(() => jump(w().id, a().surfaceId)),
      Spacer(),
    ]),
  ])
    .padding(12)
    .frame({ maxWidth: "infinity", alignment: "leading" });
  return ruled(row, () => e().last);
}

function runningRow(e: () => Last<AgentEntry>): View {
  const w = () => e().ws;
  const a = () => e().a;
  const row = HStack({ spacing: 10, alignment: "top" }, [
    statusDot(T.blue, T.blueHalo).paddingTop(2),
    VStack({ spacing: 3, alignment: "leading" }, [
      HStack({ spacing: 6 }, [
        Text(() => displayTitle(w()) || a().name || "untitled")
          .font(12.5)
          .weight("semibold")
          .color(T.text)
          .lineLimit(1)
          .truncation("middle")
          .layoutPriority(1),
        Spacer({ minLength: 4 }),
        meta(() => ageSince(a().sinceEpoch)),
      ]).frame({ maxWidth: "infinity" }),
      when(
        "progress",
        () => !!w().progress,
        () =>
          ProgressView()
            .value(() => Math.max(0, Math.min(1, w().progress?.value ?? 0)))
            .frame({ maxWidth: "infinity" }),
      ),
      when(
        "sub",
        () => !!(readable(w().latestMessage) || w().progress?.label),
        () =>
          Text(() => readable(w().latestMessage) || w().progress?.label || "")
            .font(11.5)
            .color(T.secondary)
            .lineLimit(1)
            .truncation("tail"),
      ),
    ])
      .frame({ maxWidth: "infinity", alignment: "leading" })
      .layoutPriority(1),
    glyph(e().project),
  ])
    .paddingHorizontal(12)
    .paddingVertical(10)
    .hoverBackground(T.hover)
    .frame({ maxWidth: "infinity", alignment: "leading" })
    .onTap(() => jump(w().id, a().surfaceId));
  return ruled(row, () => e().last);
}

function idleRow(e: () => Last<AgentEntry>): View {
  const w = () => e().ws;
  const a = () => e().a;
  const row = HStack({ spacing: 10 }, [
    idleRing(),
    Text(() => displayTitle(w()) || a().name || "untitled")
      .font(12.5)
      .weight("semibold")
      .color(T.secondary)
      .lineLimit(1)
      .truncation("middle")
      .layoutPriority(1),
    Spacer({ minLength: 4 }),
    meta(() => statusLine(a())),
    glyph(e().project),
  ])
    .paddingHorizontal(12)
    .paddingVertical(10)
    .hoverBackground(T.hover)
    .frame({ maxWidth: "infinity", alignment: "leading" })
    .onTap(() => jump(w().id, a().surfaceId));
  return ruled(row, () => e().last);
}

function toggleRow(count: () => number, isLast: () => boolean): View {
  const row = HStack({ spacing: 6 }, [
    Image(() => (idleOpen() ? "chevron.up" : "chevron.down"))
      .font(9)
      .weight("semibold")
      .color(T.tertiary),
    Text(() => (idleOpen() ? "Show fewer" : String(count()) + " more idle"))
      .font(11.5)
      .color(T.tertiary)
      .lineLimit(1),
    Spacer(),
  ])
    .paddingHorizontal(12)
    .paddingVertical(8)
    .hoverBackground(T.hover)
    .frame({ maxWidth: "infinity", alignment: "leading" })
    .onTap(() => setIdleOpen(!idleOpen()));
  return ruled(row, isLast);
}

/** One Running-panel row; a row's kind is fixed by its key. */
export function rosterRow(e: () => Last<RosterRow>): View {
  const kind = e().kind;
  if (kind === "run" || kind === "idle") {
    const entry = (): Last<AgentEntry> => {
      const r = e();
      if (r.kind !== "run" && r.kind !== "idle") throw new Error("roster row changed kind under key " + r.key);
      return r;
    };
    return kind === "run" ? runningRow(entry) : idleRow(entry);
  }
  if (kind === "toggle") {
    const count = () => {
      const r = e();
      return r.kind === "toggle" ? r.count : 0;
    };
    return toggleRow(count, () => e().last);
  }
  return ruled(emptyRow("Nothing running"), () => e().last);
}

export function prRow(e: () => Last<PrEntry>): View {
  const p = () => e().pr;
  const row = HStack({ spacing: 10 }, [
    Text(() => "#" + (p().number ?? ""))
      .font(12)
      .monospaced()
      .color(T.secondary)
      .lineLimit(1)
      .layoutPriority(2),
    Text(() => e().title)
      .font(12.5)
      .color(T.text)
      .lineLimit(1)
      .truncation("tail")
      .layoutPriority(1),
    Spacer({ minLength: 4 }),
    // Stale rides inside the chip: an empty sibling Text would still cost
    // its HStack spacing and squeeze the title.
    ring(
      Text(() => (p().status || "") + (p().stale ? " · stale" : ""))
        .font(11)
        .weight("medium")
        .lineLimit(1)
        .paddingHorizontal(6)
        .paddingVertical(1)
        .color(() => chipColors(p().status).fg),
      () => chipColors(p().status).bg,
      () => chipColors(p().status).edge,
      1,
      6,
      true,
    ).layoutPriority(2),
  ])
    .paddingHorizontal(12)
    .paddingVertical(10)
    .hoverBackground(T.hover)
    .frame({ maxWidth: "infinity", alignment: "leading" })
    .onTap(() => openIfUrl(p().url));
  return ruled(row, () => e().last);
}
