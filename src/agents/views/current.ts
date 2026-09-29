// "This workspace": the selected workspace in detail, what its card on the
// left has no room for. No title row: that card, highlighted, already
// names it. Todo is not in the sidebar data (issue #7), so it is left out;
// checks come from the PR poller.

import { dismissNeeds } from "../../shared/needs.ts";
import { NEUTRAL_CHIP, prChipColors, shownHealth } from "../../shared/pr-colors.ts";
import {
  branchText,
  countPill,
  linkBox,
  META_FONT,
  meta,
  motionList,
  sectionTitle,
  tapChip,
  when,
} from "../../shared/ui.ts";
import {
  type AgentRow,
  agentRows,
  askedLine,
  branchFooter,
  type CheckRow,
  cardLine,
  checkDot,
  checks,
  checksLine,
  checkWord,
  cur,
  currentAsk,
  currentPr,
  currentPrDim,
  dotFor,
  finishedLine,
  HELPER_PILL,
  haloFor,
  hasHelpers,
  headStatus,
  helperAge,
  helperCount,
  helperMore,
  helpers,
  hollowDot,
  openChecks,
  portChips,
  type SubagentRow,
  statusColor,
  statusLine,
} from "../model.ts";
import { STALE_OPACITY, STATUS_DOT, T } from "../theme.ts";
import { agentDot, jump, panel, ruled } from "./parts.ts";

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
    // Every line is a running run, so every dot reads as a working agent.
    agentDot(
      () => STATUS_DOT.working,
      () => T.blueHalo,
      () => false,
    ),
    Text(() => e().label)
      .font(12)
      .color(T.text)
      .lineLimit(1)
      .truncation("tail")
      .layoutPriority(1),
    Spacer({ minLength: 4 }),
    Text(() => helperAge(e()))
      .font(11)
      .monospaced()
      .color(T.secondary)
      .lineLimit(1)
      // Over the label's priority, so the figure ("4m", "running") is never the one cut.
      .layoutPriority(2),
  ])
    .paddingVertical(5)
    .frame({ maxWidth: "infinity", alignment: "leading" });
}

// A faint line in the helper lines' rhythm: "+2 more", "3 finished earlier".
function faintHelperLine(key: string, text: () => string): View {
  return when(
    key,
    () => !!text(),
    () => Text(text).font(11).color(T.tertiary).lineLimit(1).paddingVertical(5),
  );
}

// The Helpers block, as the left card counts them: while any run is
// running, a small caps heading and its count in working blue over one
// line per running run, ending in
// "+N more" past the cap; then one faint line for the settled ones. With
// only settled runs, that faint line stands alone, with no heading over an
// empty list. Hidden with neither, which is also what an install that never
// sends \`children\` looks like.
function helpersBlock(): View {
  return when(
    "cur-subs",
    () => hasHelpers() || !!finishedLine(),
    () =>
      VStack({ spacing: 0, alignment: "leading" }, [
        when(
          "cur-subs-live",
          () => hasHelpers(),
          () =>
            VStack({ spacing: 0, alignment: "leading" }, [
              HStack({ spacing: 6 }, [
                sectionTitle("HELPERS", T.secondary),
                countPill(
                  () => String(helperCount()),
                  () => HELPER_PILL,
                ),
              ]).paddingBottom(4),
              motionList({ items: helpers, key: (e) => e.key, spacing: 0 }, (e) => subagentLine(e)),
              faintHelperLine("cur-subs-more", () => (helperMore() > 0 ? "+" + helperMore() + " more" : "")),
            ]).frame({ maxWidth: "infinity", alignment: "leading" }),
        ),
        faintHelperLine("cur-subs-done", finishedLine),
      ])
        .frame({ maxWidth: "infinity", alignment: "leading" })
        .paddingTop(18),
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

// The checks in one line under the PR ("All 3 checks passed", "1 failing
// · 1 running"), its mark and words in the worst state's colour, faded
// while the PR's data is stale, then one
// line per check not passing: a passing check needs no line of its own.
// Hidden while the PR has none, or the workspace has no saved PR.
function checksBlock(): View {
  return when(
    "cur-checks",
    () => checks().length > 0,
    () =>
      VStack({ spacing: 0, alignment: "leading" }, [
        HStack({ spacing: 8 }, [
          Image(() => checksLine().mark)
            .font(12)
            .color(() => checksLine().color),
          Text(() => checksLine().text)
            .font(12)
            .weight("medium")
            .color(() => checksLine().color)
            .lineLimit(1),
        ])
          // Faded while the PR's data is stale, as the status row's chip is.
          .opacity(() => (currentPrDim() ? STALE_OPACITY : 1)),
        // Unmounted with nothing to list, so no empty Reorderable sits in the card.
        when(
          "cur-checks-open",
          () => openChecks().length > 0,
          () =>
            // The gap on a wrapper: the list is a Reorderable, its own stack.
            VStack({ spacing: 0, alignment: "leading" }, [
              motionList({ items: openChecks, key: (e) => e.key, spacing: 0 }, (e) => checkLine(e)),
            ])
              .frame({ maxWidth: "infinity", alignment: "leading" })
              .paddingTop(2),
        ),
      ])
        .frame({ maxWidth: "infinity", alignment: "leading" })
        .paddingTop(12),
  );
}

// Selects the workspace and focuses the asking agent's terminal. One face,
// no ring: a ring's rim would show round the hover colour.
function openChatButton(): View {
  return Text("Open chat")
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
// ask, then Open chat (only with a terminal to focus) and Dismiss. The title is
// not repeated: the highlighted card on the left already shows it.
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
          when("cur-ask-open-chat", () => !!currentAsk()?.canOpenChat, openChatButton)
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

// The labelled rows' label column, with every value on one x after it.
// Wide enough for "Asked" and "Ports".
const LABEL = 48;
const LABEL_GAP = 8;
// One gap above every line under the status, labelled rows included, the
// same 10pt the helper and check lines keep between them.
const LINE_GAP = 10;

// The card's first line, since the workspace's name and project are the
// highlighted card on the left and the heading: the dot and its word and
// age ("Working 14m") in the status colour, then the PR's state chip ("1
// failing", "ready") on the right when there is one, as the card on the
// left shows it; tapping it opens the PR. A PR with no status has no
// words, so no empty pill.
function statusRow(): View {
  const a = () => cur().a;
  return HStack({ spacing: 8 }, [
    agentDot(
      () => dotFor(a()),
      () => haloFor(a()),
      () => hollowDot(a()),
    ),
    statusWords(),
  ]).frame({ maxWidth: "infinity", alignment: "leading" });
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
        tapChip(
          () => currentPr()?.state ?? "",
          () => prChipColors(shownHealth(currentPr()?.health ?? "quiet", currentPrDim())),
          () => currentPr()?.url,
        ),
    )
      .opacity(() => (currentPrDim() ? STALE_OPACITY : 1))
      .layoutPriority(2),
  ])
    .frame({ maxWidth: "infinity", alignment: "leading" })
    .layoutPriority(1);
}

// A labelled row: a quiet label in the one label column, then the value.
// Asked and Ports both use it, so their labels share a left edge,
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

// The PR's line: its number, then its own title (the part that gives
// way). The state chip sits on the status line above, so it shows once.
function prDetail(): View {
  return (
    // On a wrapper, so only the line's own content opens the PR: the
    // frame on the link's own node would stretch its tap and hover.
    VStack({ spacing: 0, alignment: "leading" }, [
      linkBox(
        [
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
        ],
        T.secondary,
        () => currentPr()?.url,
      ),
    ]).frame({ maxWidth: "infinity", alignment: "leading" })
  );
}

// The open ports, the status part's last row.
function portsRow(): View {
  return labelled(
    "cur-ports",
    "Ports",
    () => portChips().length > 0,
    () =>
      HStack({ spacing: 6 }, [
        ForEach({ items: () => portChips(), key: (x) => x.key }, (x) =>
          tapChip(
            () => x().label,
            () => NEUTRAL_CHIP,
            () => x().url,
            true,
          ),
        ),
      ]),
  );
}

// The faint rule between the card's parts, full width, its gaps on a
// wrapper so they stay clear of the rule's own colour.
function hairline(above: number, below: number): View {
  return VStack({ spacing: 0, alignment: "leading" }, [
    Rectangle().fill(T.rule).frame({ maxWidth: "infinity", height: 1 }),
  ])
    .frame({ maxWidth: "infinity", alignment: "leading" })
    .paddingTop(above)
    .paddingBottom(below);
}

// The pull request part, under a rule: a small caps heading, the PR's
// line, then its checks. Hidden with no PR.
function prSection(): View {
  return when(
    "cur-pr",
    () => !!currentPr(),
    () =>
      VStack({ spacing: 0, alignment: "leading" }, [
        hairline(16, 14),
        sectionTitle("PULL REQUEST", T.secondary),
        prDetail().paddingTop(8),
        checksBlock(),
      ]).frame({ maxWidth: "infinity", alignment: "leading" }),
  );
}

// The branch and whether it is clean, one faint line at the foot under a
// rule, after a branch glyph: "main · clean", "main · uncommitted changes".
function branchBlock(): View {
  return when(
    "cur-branch",
    () => !!branchFooter(),
    () =>
      VStack({ spacing: 0, alignment: "leading" }, [
        hairline(16, 12),
        HStack({ spacing: 6 }, [
          Image("arrow.branch").font(10).color(T.tertiary),
          branchText(() => branchFooter(), T.tertiary),
        ]).frame({ maxWidth: "infinity", alignment: "leading" }),
      ]).frame({ maxWidth: "infinity", alignment: "leading" }),
  );
}

function currentHead(): View {
  return VStack({ spacing: 0, alignment: "leading" }, [
    statusRow(),
    askBlock(),
    askedBlock(),
    messageBlock(),
    progressBlock(),
    helpersBlock(),
    portsRow(),
    prSection(),
    branchBlock(),
  ])
    .padding(14)
    .frame({ maxWidth: "infinity", alignment: "leading" });
}

export function currentPanel(): View {
  // One live agent is already the header; list them only when there are several.
  // Unmounted below two, so the list and the head's rule change in one frame
  // and no empty Reorderable sits in the card.
  const many = () => agentRows().length > 0;
  return panel([
    ruled(currentHead(), () => !many()),
    when("cur-agents", many, () =>
      motionList({ items: agentRows, key: (e) => e.key, spacing: 0 }, (e) => ruled(agentLine(e), () => e().last)),
    ),
  ]);
}
