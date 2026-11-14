// The Details tab (#397): the selected workspace's whole story, one card
// each for what the Cockpit has waiting on Jon (#388), its sessions,
// helpers, pull request, the move its chat ended on, its background work,
// its ports and the pages it made. A card shows only while it has
// something to say; every row with a link opens it.

import type { Last } from "../../shared/list.ts";
import { prChipColors } from "../../shared/pr-colors.ts";
import { countPill, countTint, META_FONT, meta, motionList, openIfUrl, when } from "../../shared/ui.ts";
import { type BackgroundRow, backgroundRows } from "../background.ts";
import {
  type CheckDetail,
  cardShows,
  checkDetails,
  type DetailsCard,
  detailsNote,
  type HelperRow,
  helperRows,
  moveDetail,
  type PortRow,
  portRows,
  prHeadLast,
  prHeadTitle,
  prMergeLine,
  type SessionRow,
  sessionRows,
  type WaitRow,
  waitRows,
} from "../details.ts";
import { type MadeEntry, madeAge, madeOwn } from "../made.ts";
import { cur, currentPr, currentPrDim, currentPrTone, dotFor, haloFor, hollowDot, statusLine } from "../model.ts";
import { CHECK_DOT, STALE_OPACITY, T } from "../theme.ts";
import { agentDot, jump, panel, ruled, sectionHeader } from "./parts.ts";
import { faintNote, listSection } from "./sections.ts";

// Small words in proportional type, one line: a row's faint line, the
// move's decisions. meta() is monospaced, for figures.
const faintText = (text: () => string, color: Reactive<string>): View =>
  Text(text).font(META_FONT).color(color).lineLimit(1).truncation("tail");

interface DetailRow {
  /** Drawn before the words: a status dot. */
  lead?: View;
  title: () => string;
  /** The faint words on the right: an age, a duration. */
  figure: () => string;
  /** Drawn on the right in place of the figure's words: a wait's age pill. */
  trail?: View;
  /** A faint line under the title; none when it says "". */
  sub?: () => string;
  /** The faint line's colour; tertiary by default. */
  subColor?: () => string;
  /** What a tap does; a row without one has no hover. */
  tap?: () => void;
}

// The faint line's indent: past a 13pt dot frame and the 9pt gap after it.
const SUB_INDENT = 22;

// One row of a Details card: the dot, the words and the figure on the
// right, then a faint line under the words when there is one.
function detailRow(r: DetailRow, last: () => boolean): View {
  const top = HStack({ spacing: 9 }, [
    ...(r.lead ? [r.lead] : []),
    Text(r.title).font(12.5).color(T.text).lineLimit(1).truncation("tail").layoutPriority(1),
    Spacer({ minLength: 4 }),
    r.trail ?? meta(r.figure),
  ]);
  const sub = r.sub;
  const body = VStack({ spacing: 2, alignment: "leading" }, [
    top,
    ...(sub
      ? [
          when(
            "sub",
            () => !!sub(),
            () => faintText(sub, r.subColor ?? T.tertiary).paddingLeading(r.lead ? SUB_INDENT : 0),
          ),
        ]
      : []),
  ])
    .paddingHorizontal(12)
    .paddingVertical(8);
  const tap = r.tap;
  const row = tap
    ? body.hoverBackground(T.hover).frame({ maxWidth: "infinity", alignment: "leading" }).onTap(tap)
    : body.frame({ maxWidth: "infinity", alignment: "leading" });
  return ruled(row, last);
}

const plainDot = (color: () => string): View =>
  agentDot(
    color,
    () => "clear",
    () => false,
  );

// A session: its status dot, name and status age ("working 15m"), then its
// kind and last activity. A tap goes to its terminal.
function sessionRow(e: () => Last<SessionRow>): View {
  const a = () => e().a;
  return detailRow(
    {
      lead: agentDot(
        () => dotFor(a()),
        () => haloFor(a()),
        () => hollowDot(a()),
      ),
      title: () => e().label,
      figure: () => statusLine(a()),
      sub: () => e().sub,
      tap: () => jump(cur().ws.id, a().surfaceId),
    },
    () => e().last,
  );
}

// A helper: its dot, with how long it has run or took.
function helperRow(e: () => Last<HelperRow>): View {
  return detailRow(
    {
      lead: plainDot(() => e().dot),
      title: () => e().label,
      figure: () => e().figure,
    },
    () => e().last,
  );
}

function checkRow(e: () => Last<CheckDetail>): View {
  return detailRow(
    {
      lead: plainDot(() => CHECK_DOT[e().state]),
      title: () => e().name,
      figure: () => e().figure,
      tap: () => openIfUrl(e().url),
    },
    () => e().last,
  );
}

// A background task: its description, then its kind and how long it has
// run ("shell, 2m"). No dot, as every listed task runs, and no tap, as
// there is nowhere of its own to go.
function backgroundRow(e: () => Last<BackgroundRow>): View {
  return detailRow({ title: () => e().label, figure: () => e().figure }, () => e().last);
}

// A wait on Jon the Cockpit saved: an amber dot, its word, how long in an
// amber pill, then why under it. No tap and no Dismiss: the Cockpit
// dismisses it, and the saved wait goes with that.
function waitRow(e: () => Last<WaitRow>): View {
  const amber = countTint("asking");
  return detailRow(
    {
      lead: plainDot(() => T.amber),
      title: () => e().word,
      figure: () => e().age,
      trail: countPill(
        () => e().age,
        () => amber,
      ),
      sub: () => e().detail,
    },
    () => e().last,
  );
}

function portRow(e: () => Last<PortRow>): View {
  return detailRow(
    { title: () => e().label, figure: () => "localhost", tap: () => openIfUrl(e().url) },
    () => e().last,
  );
}

function madeRow(e: () => Last<MadeEntry>): View {
  return detailRow(
    { title: () => e().title, figure: () => madeAge(e()), tap: () => openIfUrl(e().url) },
    () => e().last,
  );
}

// The PR's own row: its title and number, then its state in its chip's
// colour ("1 failing", "draft"); a tap opens it. Words rather than a chip,
// so the number and title keep their room.
function prHead(): View {
  const pr = () => currentPr();
  return detailRow(
    {
      title: prHeadTitle,
      figure: () => pr()?.tag ?? "",
      sub: () => pr()?.state ?? "",
      subColor: () => prChipColors(currentPrTone()).fg,
      tap: () => openIfUrl(pr()?.url),
    },
    prHeadLast,
  );
}

// The pull request card: its own row, every check, then whether it can
// merge and its size. The checks and that line fade while the saved PR
// data is stale, as the Now tab's do.
function prSection(): View {
  const faded = () => (currentPrDim() ? STALE_OPACITY : 1);
  return when("d-pr", cardShows.pr, () =>
    VStack({ spacing: 8, alignment: "leading" }, [
      sectionHeader("PULL REQUEST"),
      panel([
        prHead(),
        VStack({ spacing: 0, alignment: "leading" }, [
          motionList({ items: checkDetails, key: (e) => e.key, spacing: 0 }, checkRow),
          when(
            "d-pr-merge",
            () => !!prMergeLine(),
            () =>
              Text(prMergeLine)
                .font(11)
                .color(T.secondary)
                .lineLimit(2)
                .paddingHorizontal(12)
                .paddingVertical(8)
                .frame({ maxWidth: "infinity", alignment: "leading" }),
          ),
        ])
          .frame({ maxWidth: "infinity", alignment: "leading" })
          .opacity(faded),
      ]),
    ]),
  );
}

// The move the chat ended its turn on, its decisions and leans under it.
function moveSection(): View {
  const m = () => moveDetail();
  return when("d-move", cardShows.move, () =>
    VStack({ spacing: 8, alignment: "leading" }, [
      sectionHeader("YOUR MOVE"),
      panel([
        VStack({ spacing: 4, alignment: "leading" }, [
          Text(() => m()?.text ?? "")
            .font(12.5)
            .color(T.text)
            .lineLimit(6)
            .truncation("tail")
            .frame({ maxWidth: "infinity", alignment: "leading" }),
          when(
            "d-move-meta",
            () => !!m()?.meta,
            () => faintText(() => m()?.meta ?? "", T.secondary),
          ),
        ])
          .paddingHorizontal(12)
          .paddingVertical(10)
          .frame({ maxWidth: "infinity", alignment: "leading" }),
      ]),
    ]),
  );
}

// A list card, left out altogether while the model says it does not show.
function listCard<T extends { key: string; last: boolean }>(
  label: string,
  card: DetailsCard,
  rows: () => T[],
  row: (e: () => T) => View,
): View {
  const key = "d-" + card;
  return when(key + "-section", cardShows[card], () =>
    listSection({ label, key, count: () => rows().length, rows, row }),
  );
}

// Each card by its name in the model's list, in the issue's order, so a
// card added on one side and not the other fails the type check.
const CARDS: Readonly<Record<DetailsCard, () => View>> = {
  waits: () => listCard("WAITING ON YOU", "waits", waitRows, waitRow),
  sessions: () => listCard("SESSIONS", "sessions", sessionRows, sessionRow),
  helpers: () => listCard("HELPERS", "helpers", helperRows, helperRow),
  pr: prSection,
  move: moveSection,
  background: () => listCard("BACKGROUND WORK", "background", backgroundRows, backgroundRow),
  ports: () => listCard("PORTS", "ports", portRows, portRow),
  made: () => listCard("MADE HERE", "made", madeOwn, madeRow),
};

/** The Details tab's cards, in the issue's order, then a faint line when
 * there is nothing to show. */
export function detailsPanel(): View {
  return VStack({ spacing: 18, alignment: "leading" }, [
    ...Object.values(CARDS).map((card) => card()),
    faintNote("d-note", detailsNote),
  ]).frame({ maxWidth: "infinity", alignment: "leading" });
}
