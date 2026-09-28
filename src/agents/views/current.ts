// "This workspace": the selected workspace in detail, what its card on the
// left has no room for. Todo is not in the sidebar data (issue #7), so it is
// left out; checks come from the PR poller.

import { dismissNeeds } from "../../shared/needs.ts";
import { NEUTRAL_CHIP, summaryColors } from "../../shared/pr-colors.ts";
import { displayTitle } from "../../shared/titles.ts";
import { branchText, chip, META_FONT, meta, projectBadge, sectionTitle, unreadBadge, when } from "../../shared/ui.ts";
import {
  type AgentRow,
  agentRows,
  askedLine,
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
  currentPrDim,
  dotFor,
  haloFor,
  hasDetails,
  headStatus,
  hollowDot,
  portChips,
  type SubagentRow,
  statusColor,
  statusLine,
  subagentDot,
  subagentFigure,
  subagentHalo,
  subagentLabelColor,
  subagents,
} from "../model.ts";
import { STALE_OPACITY, T } from "../theme.ts";
import { agentDot, jump, openIfUrl, panel, ruled } from "./parts.ts";

function agentLine(e: () => AgentRow): View {
  const a = () => e().a;
  return HStack({ spacing: 8 }, [
    agentDot(
      () => dotFor(a()),
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
      // Over the label's priority, so the figure ("4m", "done") is never the one cut.
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
        sectionTitle("SUBAGENTS", T.secondary).paddingBottom(2),
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
          sectionTitle("CHECKS", T.secondary),
          Text(() => checksFigure(checks()))
            .font(10.5)
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
        .paddingTop(LINE_GAP),
  );
}

// The card's two columns (issue #94). The head's icon column, with the title
// and the status word on one x after it; and the labelled rows' label column,
// with every value on one x after it. Labels start at the card's padding, as
// the icon does. The label column is wider than the icon's, since "Branch"
// does not fit in 26pt.
const ICON = 26;
const ICON_GAP = 10;
const LABEL = 48;
const LABEL_GAP = 8;
// One gap above every line under the title, labelled rows included, the same
// 10pt the subagent and check lines keep between them.
const LINE_GAP = 10;

// Project icon, then the title over the project name, then the unread
// badge. No status here, so the title has the line to itself (Board 1).
function currentTitle(): View {
  const w = () => cur().ws;
  return HStack({ spacing: ICON_GAP }, [
    // The full card's badge size on the left, so the project reads the same.
    projectBadge(() => cur().project, ICON, 12, 8),
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
    // Behind a when(), so with nothing unread the title keeps the row's full width.
    when(
      "cur-unread",
      () => (w().unread ?? 0) > 0,
      () => unreadBadge(() => w().unread ?? 0),
    ),
  ]).frame({ maxWidth: "infinity" });
}

// The status on its own line under the title (Board 1): the dot and its
// word and age ("Working 14m") in the status colour, then the PR's state
// chip ("1 failing", "ready") on the right when there is one, as the card
// on the left shows it; tapping it opens the PR. A PR with no status has
// no words, so no empty pill. The dot is centred under the project icon and
// the word starts on the title's x (issue #94).
function statusRow(): View {
  const a = () => cur().a;
  // The head's own two columns, so the word cannot drift off the title's x.
  return HStack({ spacing: ICON_GAP }, [
    agentDot(
      () => dotFor(a()),
      () => haloFor(a()),
      () => hollowDot(a()),
    )
      // A fixed width centres its content, which is what puts the dot under the icon.
      .frame({ width: ICON }),
    statusWords(),
  ])
    .frame({ maxWidth: "infinity", alignment: "leading" })
    .paddingTop(LINE_GAP);
}

// The status row's text column: the word and age, then the PR chip on the right.
function statusWords(): View {
  const a = () => cur().a;
  return HStack({ spacing: 6 }, [
    Text(() => headStatus(a()))
      .font(12.5)
      .weight("medium")
      .color(() => statusColor(a()))
      .lineLimit(1)
      .layoutPriority(1),
    Spacer({ minLength: 4 }),
    when(
      "cur-status-pr",
      () => !!currentPr()?.state,
      () =>
        chip(
          () => currentPr()?.state ?? "",
          () => summaryColors(currentPr()),
        ).onTap(() => openIfUrl(currentPr()?.url)),
    )
      .opacity(() => (currentPrDim() ? STALE_OPACITY : 1))
      .layoutPriority(2),
  ])
    .frame({ maxWidth: "infinity", alignment: "leading" })
    .layoutPriority(1);
}

// A labelled row: a quiet label in the one label column, then the value.
// Asked, Branch, Ports and PR all use it, so their labels share a left edge,
// their values share another, and each row keeps the same gap above it.
// Align "top" to pin the label to the value's first line, for a value that
// wraps; label and value share one size, so their first lines line up. A
// single-line row stays centred, which keeps the label level with a chip's
// words rather than its edge.
function labelled(
  key: string,
  label: string,
  show: () => boolean,
  value: () => View,
  alignment: Alignment = "center",
): View {
  return when(key, show, () =>
    HStack({ spacing: LABEL_GAP, alignment }, [
      // A fixed-width frame centres its content whatever the alignment, so the
      // label first fills the column with the maxWidth frame that does honour it.
      Text(label)
        .font(META_FONT)
        .color(T.tertiary)
        .lineLimit(1)
        .frame({ maxWidth: "infinity", alignment: "leading" })
        .frame({ width: LABEL }),
      value(),
    ])
      .frame({ maxWidth: "infinity", alignment: "leading" })
      .paddingTop(LINE_GAP),
  );
}

// The last prompt, over the agent's reply to it (issue #80), in the same
// label column and value size as the rows below (issue #94).
function askedBlock(): View {
  return labelled(
    "cur-asked",
    "Asked",
    () => !!askedLine(),
    () =>
      Text(() => askedLine())
        .font(META_FONT)
        .color(T.secondary)
        .lineLimit(2)
        .truncation("tail")
        .frame({ maxWidth: "infinity", alignment: "leading" })
        .layoutPriority(1),
    "top",
  );
}

// The agent's latest message, set apart on a faint face.
function messageBlock(): View {
  return when(
    "cur-msg",
    () => !!cardLine(),
    () =>
      // The gap on a wrapper: on the face's own node the quote colour would fill it.
      VStack({ spacing: 0, alignment: "leading" }, [
        Text(() => cardLine())
          .font(12)
          .color(T.secondary)
          .lineLimit(4)
          .truncation("tail")
          .paddingHorizontal(8)
          .paddingVertical(6)
          .frame({ maxWidth: "infinity", alignment: "leading" })
          .background(T.quote)
          .cornerRadius(6),
      ])
        .frame({ maxWidth: "infinity", alignment: "leading" })
        .paddingTop(LINE_GAP),
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
      ]).paddingTop(LINE_GAP),
  );
}

// The PR line's value: its number, then its own title (the part that gives
// way). The state chip sits on the status line above, so it shows once.
function prDetail(): View {
  return (
    HStack({ spacing: 6 }, [
      meta(() => currentPr()?.tag ?? "", T.secondary),
      when(
        "cur-pr-title",
        () => !!currentPr()?.title,
        () =>
          Text(() => currentPr()?.title ?? "")
            .font(META_FONT)
            .color(T.secondary)
            .lineLimit(1)
            .truncation("tail"),
      ),
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
      // No gap of its own: each labelled row carries the one above it.
      VStack({ spacing: 0, alignment: "leading" }, [
        labelled(
          "cur-branch",
          "Branch",
          () => !!branchDetail(),
          () => branchText(() => branchDetail(), T.secondary).layoutPriority(1),
        ),
        labelled(
          "cur-ports",
          "Ports",
          () => portChips().length > 0,
          () =>
            HStack({ spacing: 6 }, [
              ForEach({ items: () => portChips(), key: (x) => x.key }, (x) =>
                chip(
                  () => x().label,
                  () => NEUTRAL_CHIP,
                  true,
                ).onTap(() => openURL(x().url)),
              ),
            ]),
        ),
        labelled(
          "cur-pr",
          "PR",
          () => !!currentPr(),
          () => prDetail(),
        ),
      ]).frame({ maxWidth: "infinity", alignment: "leading" }),
  );
}

function currentHead(): View {
  return VStack({ spacing: 0, alignment: "leading" }, [
    currentTitle(),
    statusRow(),
    askBlock(),
    askedBlock(),
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
