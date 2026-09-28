// "This workspace": the selected workspace in detail, what its card on the
// left has no room for. Todo is not in the sidebar data (issue #7), so it is
// left out; checks come from the PR poller.

import { glyphColor } from "../../shared/contrast.ts";
import { dismissNeeds } from "../../shared/needs.ts";
import { prChipColors } from "../../shared/pr-colors.ts";
import { tracked } from "../../shared/text.ts";
import { displayTitle } from "../../shared/titles.ts";
import { when } from "../../shared/ui.ts";
import {
  type AgentRow,
  agentRows,
  branchDetail,
  type CheckRow,
  cardLine,
  checkDot,
  checks,
  checksFigure,
  checkWord,
  cur,
  currentAsk,
  currentPr,
  haloFor,
  hasDetails,
  headStatus,
  hollowDot,
  portChips,
  type SubagentRow,
  statusLine,
  subagentDot,
  subagentFigure,
  subagentHalo,
  subagentLabelColor,
  subagents,
} from "../model.ts";
import { PORT_CHIP, STATUS_DOT, STATUS_TEXT, T } from "../theme.ts";
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
      .color(() => subagentLabelColor(e()))
      .lineLimit(1)
      .truncation("tail")
      .layoutPriority(1),
    Spacer({ minLength: 4 }),
    Text(() => subagentFigure(e()))
      .font(11)
      .monospaced()
      .color(T.secondary)
      .lineLimit(1)
      // Over the label's priority, so "finished 12m ago" is never the one cut.
      .layoutPriority(2),
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

// Selects the workspace and focuses the asking agent's terminal. One face,
// no ring: a ring's rim would show round the hover colour.
function answerButton(): View {
  return Text("Answer")
    .font(12)
    .weight("semibold")
    .color(T.onClay)
    .lineLimit(1)
    .paddingHorizontal(12)
    .paddingVertical(4)
    .background(T.clayButton)
    .hoverBackground(T.clayButtonHover)
    .cornerRadius(8)
    .onTap(() => jump(cur().ws.id, currentAsk()?.a.surfaceId));
}

// Local to this panel: the cockpit's dismissals are not visible here (issue #3).
function dismissButton(): View {
  return Text(() => currentAsk()?.dismissLabel ?? "Dismiss")
    .font(12)
    .color(T.secondary)
    .lineLimit(1)
    .paddingHorizontal(8)
    .paddingVertical(4)
    .hoverBackground(T.hover)
    .cornerRadius(8)
    .layoutPriority(1)
    .onTap(() => dismissNeeds(cur().ws));
}

// The question, when the agent needs you: its words (none when there is only
// the generic fallback or they may be another agent's), or how many agents
// ask, then Answer (only with a terminal to focus) and Dismiss. The title is
// not repeated: the card's head already shows it.
function askBlock(): View {
  return when(
    "cur-ask",
    () => !!currentAsk(),
    () =>
      VStack({ spacing: 8, alignment: "leading" }, [
        when(
          "cur-ask-text",
          () => !!currentAsk()?.text,
          () =>
            Text(() => currentAsk()?.text ?? "")
              .font(13)
              .color(T.text)
              .lineLimit(3)
              .truncation("tail")
              .frame({ maxWidth: "infinity", alignment: "leading" }),
        ),
        HStack({ spacing: 6 }, [
          when("cur-ask-answer", () => !!currentAsk()?.canAnswer, answerButton)
            // Priority on the when() result, the HStack's child, so the label
            // never wraps; a priority inside it does not reach this HStack.
            .layoutPriority(2),
          dismissButton(),
          Spacer(),
        ]).frame({ maxWidth: "infinity" }),
      ])
        .frame({ maxWidth: "infinity", alignment: "leading" })
        .paddingTop(8),
  );
}

// Title and project (the branch is in the details below), then the status
// dot with its word and age ("Working 14m"), then the unread badge.
function currentTitle(): View {
  const w = () => cur().ws;
  const a = () => cur().a;
  const status = () => a()?.status;
  const unread = () => w().unread ?? 0;
  return HStack({ spacing: 10 }, [
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
      Text(() => cur().project.name)
        .font(11.5)
        .color(T.metaText)
        .lineLimit(1)
        .truncation("tail"),
    ])
      .frame({ maxWidth: "infinity", alignment: "leading" })
      .layoutPriority(1),
    HStack({ spacing: 6 }, [
      agentDot(
        () => {
          const s = status();
          return s ? STATUS_DOT[s] : T.grey;
        },
        () => haloFor(a()),
        () => hollowDot(a()),
      ),
      Text(() => headStatus(a()))
        .font(12)
        .weight("medium")
        .color(() => {
          const s = status();
          return s ? STATUS_TEXT[s] : T.secondary;
        })
        .lineLimit(1),
    ]).layoutPriority(2),
    when(
      "cur-unread",
      () => unread() > 0,
      () =>
        Text(() => String(unread()))
          .font(10)
          .bold()
          .color(T.onClay)
          .paddingHorizontal(5)
          .paddingVertical(1)
          .background(T.clayButton)
          .cornerRadius(7),
    ),
  ]).frame({ maxWidth: "infinity" });
}

// The agent's latest message, set apart on a faint face.
function messageBlock(): View {
  return when(
    "cur-msg",
    () => !!cardLine(),
    () =>
      Text(() => cardLine())
        .font(12)
        .color(T.secondary)
        .lineLimit(4)
        .truncation("tail")
        .paddingHorizontal(8)
        .paddingVertical(6)
        .frame({ maxWidth: "infinity", alignment: "leading" })
        .background(T.quote)
        .cornerRadius(6)
        .paddingTop(10),
  );
}

function progressBlock(): View {
  const w = () => cur().ws;
  return when(
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
  );
}

// One "Branch", "Ports" or "PR" line: a quiet label column, then the value.
function detailLine(key: string, label: string, show: () => boolean, value: () => View): View {
  return when(key, show, () =>
    HStack({ spacing: 8 }, [
      // A fixed-width frame centres its content whatever the alignment, so the
      // label first fills the column with the maxWidth frame that does honour it.
      Text(label)
        .font(11.5)
        .color(T.tertiary)
        .lineLimit(1)
        .frame({ maxWidth: "infinity", alignment: "leading" })
        .frame({ width: 48 }),
      value(),
    ])
      .paddingVertical(3)
      .frame({ maxWidth: "infinity", alignment: "leading" }),
  );
}

// The PR line's value: its number, its own title (the part that gives way),
// then the chip with its worst state, as the card on the left shows it.
function prDetail(): View {
  return (
    HStack({ spacing: 6 }, [
      Text(() => currentPr()?.tag ?? "")
        .font(11.5)
        .monospaced()
        .color(T.secondary)
        .lineLimit(1)
        .layoutPriority(2),
      when(
        "cur-pr-title",
        () => !!currentPr()?.title,
        () =>
          Text(() => currentPr()?.title ?? "")
            .font(11.5)
            .color(T.secondary)
            .lineLimit(1)
            .truncation("tail"),
      ),
      // A PR with no status has no words, so no empty pill.
      when(
        "cur-pr-state",
        () => !!currentPr()?.state,
        () =>
          chip(
            () => currentPr()?.state ?? "",
            () => prChipColors(currentPr()?.health ?? "quiet", currentPr()?.status, currentPr()?.draft),
          ),
      ).layoutPriority(2),
    ])
      // Inside the frame, so only the line's own content opens the PR.
      .onTap(() => openIfUrl(currentPr()?.url))
      .frame({ maxWidth: "infinity", alignment: "leading" })
  );
}

function detailsBlock(): View {
  return when(
    "cur-details",
    () => hasDetails(),
    () =>
      VStack({ spacing: 0, alignment: "leading" }, [
        detailLine(
          "cur-branch",
          "Branch",
          () => !!branchDetail(),
          () =>
            Text(() => branchDetail())
              .font(11.5)
              .color(T.secondary)
              .lineLimit(1)
              .truncation("middle")
              .layoutPriority(1),
        ),
        detailLine(
          "cur-ports",
          "Ports",
          () => portChips().length > 0,
          () =>
            HStack({ spacing: 6 }, [
              ForEach({ items: () => portChips(), key: (x) => x.key }, (x) =>
                chip(
                  () => x().label,
                  () => PORT_CHIP,
                ).onTap(() => openURL(x().url)),
              ),
            ]),
        ),
        detailLine(
          "cur-pr",
          "PR",
          () => !!currentPr(),
          () => prDetail(),
        ),
      ])
        .frame({ maxWidth: "infinity", alignment: "leading" })
        .paddingTop(10),
  );
}

function currentHead(): View {
  return VStack({ spacing: 0, alignment: "leading" }, [
    currentTitle(),
    askBlock(),
    messageBlock(),
    progressBlock(),
    subagentsBlock(),
    detailsBlock(),
    checksBlock(),
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
