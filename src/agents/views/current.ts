// "This workspace": the selected workspace's card. Todo is not in the
// sidebar data (issue #7), so it is left out; checks come from the PR poller.

import { glyphColor } from "../../shared/contrast.ts";
import { prChipColors } from "../../shared/pr-colors.ts";
import { prSummary } from "../../shared/prs.ts";
import { cardMessage, tracked } from "../../shared/text.ts";
import { displayTitle } from "../../shared/titles.ts";
import { when } from "../../shared/ui.ts";
import {
  type AgentRow,
  agentRows,
  type CheckRow,
  checkDot,
  checks,
  checksFigure,
  checkWord,
  cur,
  haloFor,
  hollowDot,
  type SubagentRow,
  statusLine,
  statusPhrase,
  subagentDot,
  subagentFigure,
  subagentHalo,
  subagents,
} from "../model.ts";
import { chipColors, STATUS_DOT, STATUS_TEXT, T } from "../theme.ts";
import { agentDot, chip, jump, meta, openIfUrl, panel, ruled } from "./parts.ts";

function agentLine(e: () => AgentRow): View {
  const a = () => e().a;
  return HStack({ spacing: 8 }, [
    agentDot(
      () => STATUS_DOT[a().status] ?? T.grey,
      () => haloFor(a()),
      () => hollowDot(a()),
    ),
    Text(() => e().label)
      .font(12)
      .color(T.text)
      .lineLimit(1)
      .truncation("tail")
      .layoutPriority(1),
    Spacer({ minLength: 4 }),
    meta(() => statusLine(a())),
  ])
    .paddingHorizontal(12)
    .paddingVertical(7)
    .hoverBackground(T.hover)
    .frame({ maxWidth: "infinity", alignment: "leading" })
    .onTap(() => jump(cur().ws.id, a().surfaceId));
}

function subagentLine(e: () => SubagentRow): View {
  return HStack({ spacing: 9 }, [
    agentDot(
      () => subagentDot(e()),
      () => subagentHalo(e()),
      () => false,
    ),
    Text(() => e().label)
      .font(12)
      .color(T.text)
      .lineLimit(1)
      .truncation("tail")
      .layoutPriority(1),
    Spacer({ minLength: 4 }),
    Text(() => subagentFigure(e()))
      .font(11)
      .monospaced()
      .color(T.secondary)
      .lineLimit(1),
  ])
    .paddingVertical(5)
    .frame({ maxWidth: "infinity", alignment: "leading" });
}

// Board 1's Subagents block: a small caps heading over one line per run.
// Hidden while the workspace has none, which is also what an install that
// never sends `children` looks like.
function subagentsBlock(): View {
  return when(
    "cur-subs",
    () => subagents().length > 0,
    () =>
      VStack({ spacing: 0, alignment: "leading" }, [
        Text(tracked("SUBAGENTS")).font(10).weight("semibold").color(T.tertiary).lineLimit(1).paddingBottom(2),
        ForEach({ items: () => subagents(), key: (e) => e.key }, (e) => subagentLine(e)),
      ])
        .frame({ maxWidth: "infinity", alignment: "leading" })
        .paddingTop(12),
  );
}

function checkLine(e: () => CheckRow): View {
  return HStack({ spacing: 9 }, [
    agentDot(
      () => checkDot(e()),
      () => "clear",
      () => false,
    ),
    Text(() => e().name)
      .font(12)
      .color(T.text)
      .lineLimit(1)
      .truncation("tail")
      .layoutPriority(1),
    Spacer({ minLength: 4 }),
    Text(() => checkWord(e()))
      .font(11)
      .color(T.secondary)
      .lineLimit(1),
  ])
    .paddingVertical(5)
    .frame({ maxWidth: "infinity", alignment: "leading" });
}

// Board 1's Checks block: "CHECKS 3 / 5" over one line per check. Hidden
// while the PR has none, or the workspace has no saved PR.
function checksBlock(): View {
  return when(
    "cur-checks",
    () => checks().length > 0,
    () =>
      VStack({ spacing: 0, alignment: "leading" }, [
        HStack({ spacing: 6 }, [
          Text(tracked("CHECKS")).font(10).weight("semibold").color(T.tertiary).lineLimit(1),
          Text(() => checksFigure(checks()))
            .font(10)
            .monospaced()
            .color(T.tertiary)
            .lineLimit(1),
        ]).paddingBottom(2),
        ForEach({ items: () => checks(), key: (e) => e.key }, (e) => checkLine(e)),
      ])
        .frame({ maxWidth: "infinity", alignment: "leading" })
        .paddingTop(12),
  );
}

function currentHead(): View {
  const w = () => cur().ws;
  const a = () => cur().a;
  const status = () => a()?.status;
  const unread = () => w().unread ?? 0;
  const pr = computed(() => prSummary(w()));
  return VStack({ spacing: 0, alignment: "leading" }, [
    HStack({ spacing: 10 }, [
      ZStack({}, [
        RoundedRectangle({ cornerRadius: 8 }).fill(() => cur().project.color),
        Image(() => cur().project.icon)
          .font(12)
          .color(() => glyphColor(cur().project.color, T.text)),
      ]).frame({ width: 26, height: 26 }),
      VStack({ spacing: 1, alignment: "leading" }, [
        Text(() => displayTitle(w()) || "untitled")
          .font(14)
          .weight("semibold")
          .color(T.text)
          .lineLimit(1)
          .truncation("middle"),
        Text(() =>
          [cur().project.name, w().branch ? w().branch + (w().dirty ? " · uncommitted" : "") : ""]
            .filter(Boolean)
            .join(" · "),
        )
          .font(11.5)
          .color(T.metaText)
          .lineLimit(1)
          .truncation("tail"),
      ])
        .frame({ maxWidth: "infinity", alignment: "leading" })
        .layoutPriority(1),
      when(
        "cur-unread",
        () => unread() > 0,
        () =>
          Text(() => String(unread()))
            .font(10)
            .bold()
            .color("white")
            .paddingHorizontal(5)
            .paddingVertical(1)
            .background(T.clayButton)
            .cornerRadius(7),
      ),
    ]).frame({ maxWidth: "infinity" }),
    HStack({ spacing: 8 }, [
      agentDot(
        () => {
          const s = status();
          return s ? STATUS_DOT[s] : T.grey;
        },
        () => haloFor(a()),
        () => hollowDot(a()),
      ),
      Text(() => statusPhrase(a()))
        .font(13)
        .weight("medium")
        .color(() => {
          const s = status();
          return s ? STATUS_TEXT[s] : T.secondary;
        })
        .lineLimit(1)
        .layoutPriority(1),
      Spacer({ minLength: 4 }),
      when(
        "cur-pr",
        () => !!pr(),
        () =>
          chip(
            () => pr()?.text ?? "",
            () => prChipColors(pr()?.health ?? "quiet", pr()?.status),
          ).onTap(() => openIfUrl(pr()?.url)),
      )
        // Priority over the status phrase, so the chip is never the one cut.
        // It sits on the when() result because a priority inside it does not
        // reach this HStack.
        .layoutPriority(2),
    ])
      .frame({ maxWidth: "infinity" })
      .paddingTop(14),
    when(
      "cur-msg",
      () => !!cardMessage(w()),
      () =>
        Text(() => cardMessage(w()))
          .font(12)
          .color(T.secondary)
          .lineLimit(3)
          .truncation("tail")
          .frame({ maxWidth: "infinity", alignment: "leading" })
          .paddingTop(6),
    ),
    when(
      "cur-progress",
      () => !!w().progress,
      () =>
        VStack({ spacing: 4, alignment: "leading" }, [
          ProgressView()
            .value(() => Math.max(0, Math.min(1, w().progress?.value ?? 0)))
            .frame({ maxWidth: "infinity" }),
          Text(() => w().progress?.label || "")
            .font(11)
            .color(T.secondary)
            .lineLimit(1),
        ]).paddingTop(10),
    ),
    when(
      "cur-ports",
      () => (w().ports ?? []).length > 0,
      () =>
        HStack({ spacing: 6 }, [
          ForEach(
            { items: () => (w().ports ?? []).slice(0, 3).map((n) => ({ id: "p" + n, n })), key: (x) => x.id },
            (x) =>
              chip(
                () => ":" + x().n,
                () => chipColors("port"),
              ).onTap(() => openURL("http://localhost:" + x().n)),
          ),
          // Left-aligned by the frame, not a Spacer, which would take half the
          // row from the port chips.
        ])
          .frame({ maxWidth: "infinity", alignment: "leading" })
          .paddingTop(10),
    ),
    checksBlock(),
    subagentsBlock(),
  ])
    .padding(14)
    .frame({ maxWidth: "infinity", alignment: "leading" });
}

export function currentPanel(): View {
  // One live agent is already the header; list them only when there are several.
  const many = () => agentRows().length > 0;
  return panel([
    ruled(currentHead(), () => !many()),
    ForEach({ items: () => agentRows(), key: (e) => e.key }, (e) => ruled(agentLine(e), () => e().last)),
  ]);
}
