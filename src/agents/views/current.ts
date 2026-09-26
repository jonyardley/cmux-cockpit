// "This workspace": the selected workspace's card. Checks, subagents and
// todo are not in the sidebar data (issue #7), so they are left out.

import { type Last, markLast } from "../../shared/list.ts";
import { cardMessage, readable } from "../../shared/text.ts";
import { displayTitle } from "../../shared/titles.ts";
import { when } from "../../shared/ui.ts";
import { cur, hollowDot, statusLine, statusPhrase } from "../model.ts";
import { chipColors, STATUS_DOT, STATUS_TEXT, T } from "../theme.ts";
import { agentDot, chip, jump, meta, openIfUrl, panel, ruled } from "./parts.ts";

function agentLine(e: () => Last<{ key: string; a: Agent }>): View {
  const a = () => e().a;
  return HStack({ spacing: 8 }, [
    agentDot(
      () => STATUS_DOT[a().status] ?? T.grey,
      () => "clear",
      () => hollowDot(a()),
    ),
    Text(() => readable(a().title) || a().name || a().kind || "agent")
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

function currentHead(): View {
  const w = () => cur().ws;
  const a = () => cur().a;
  const status = () => a()?.status;
  const unread = () => w().unread ?? 0;
  return VStack({ spacing: 0, alignment: "leading" }, [
    HStack({ spacing: 10 }, [
      ZStack({}, [
        RoundedRectangle({ cornerRadius: 8 }).fill(() => cur().project.color),
        Image(() => cur().project.icon)
          .font(12)
          .color("#FFFFFF"),
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
          .color("#6B6A64")
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
        () => (status() === "working" ? T.blueHalo : "clear"),
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
        () => !!w().pr,
        () =>
          chip(
            () => "#" + (w().pr?.number ?? "") + " " + (w().pr?.status ?? ""),
            () => chipColors(w().pr?.status),
          ).onTap(() => openIfUrl(w().pr?.url)),
      ),
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
          Spacer(),
        ]).paddingTop(10),
    ),
  ])
    .padding(14)
    .frame({ maxWidth: "infinity", alignment: "leading" });
}

export function currentPanel(): View {
  // One agent is already the header; list them only when there are several.
  const many = () => cur().agents.length > 1;
  return panel([
    ruled(currentHead(), () => !many()),
    ForEach(
      {
        items: () =>
          many()
            ? markLast(
                cur()
                  .agents.slice(0, 6)
                  .map((a) => ({ key: "a:" + a.id, a })),
              )
            : [],
        key: (e) => e.key,
      },
      (e) => ruled(agentLine(e), () => e().last),
    ),
  ]);
}
