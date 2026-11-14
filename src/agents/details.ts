// The agents panel's two tabs (#397): Now, today's panel, and Details, the
// selected workspace's whole story from data the panel already reads. Which
// tab shows is panel state, remembered per workspace until reload; the rest
// are pure reads of `data` and the saved state, so each is testable alone.

import type { SavedCheck } from "../../scripts/state-config.ts";
import type { Last } from "../shared/list.ts";
import { markLast } from "../shared/list.ts";
import { asksNothing, waitingMove } from "../shared/move.ts";
import { askReason } from "../shared/needs.ts";
import { checksOf, diffText, prOf } from "../shared/prs.ts";
import { ageSince } from "../shared/time.ts";
import { withAge } from "../shared/words.ts";
import { checkRows } from "./checks.ts";
import { madeOwn } from "./made.ts";
import { cur, current, currentPr } from "./model.ts";
import { agentLabels, type SubagentRow, subagents } from "./team.ts";

// ---- The tab switch ------------------------------------------------------------

export type Tab = "now" | "details";

// wsId -> the tab chosen there; a workspace not in it shows Now. Not saved:
// a reload lands every workspace back on Now.
const [chosen, setChosen] = signal<ReadonlyMap<string, Tab>>(new Map());

/** The tab the selected workspace shows: the one last chosen there, else Now. */
export const tabOf = (): Tab => chosen().get(cur().ws.id) ?? "now";

/** Shows tab `t` for the selected workspace, and remembers it there. */
export function chooseTab(t: Tab): void {
  const id = cur().ws.id;
  const next = new Map(chosen());
  if (t === "now") next.delete(id);
  else next.set(id, t);
  setChosen(next);
}

// ---- Durations -------------------------------------------------------------------

/**
 * A span in words, finer than an age, since a check or helper can take
 * seconds: "40s", "1m 10s" under ten minutes, "22m", "1h 12m"; "" for a bad
 * input.
 */
export function fmtSpan(secs: number): string {
  if (!(secs >= 0)) return "";
  const s = Math.floor(secs);
  if (s < 60) return s + "s";
  const m = Math.floor(s / 60);
  if (m < 10) return s % 60 ? `${m}m ${s % 60}s` : `${m}m`;
  if (m < 60) return m + "m";
  const h = Math.floor(m / 60);
  return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
}

/** "2m ago", or "just now" under a minute; "" without a time or clock. */
function agoText(at: number | undefined): string {
  const age = ageSince(at);
  if (!age) return "";
  return age === "<1m" ? "just now" : age + " ago";
}

// ---- Sessions --------------------------------------------------------------------

export interface SessionRow {
  key: string;
  a: Agent;
  label: string;
  /** The faint line under it: its kind and when it was last active, "Claude, last activity 2m ago". */
  sub: string;
}

const KIND_WORD: Record<string, string> = { claude: "Claude", codex: "Codex" };

/** An agent's kind as a word: "Claude", "Codex", or cmux's own word for any other. */
export const kindWord = (kind: string | undefined): string => (kind ? (KIND_WORD[kind] ?? kind) : "");

/** A session's faint line: its kind, then its last activity; either alone, or "". */
export function sessionSub(a: Agent): string {
  const seen = agoText(a.lastActivityAt);
  return [kindWord(a.kind), seen ? "last activity " + seen : ""].filter(Boolean).join(", ");
}

/** Every agent in the selected workspace, ended ones too, most active
 * first, named as the Now tab's agent rows name them. No cap: the tab is
 * where the whole list lives. */
export const sessionRows = computed((): Last<SessionRow>[] => {
  const { agents, inOrder } = cur();
  const labels = agentLabels(inOrder);
  return markLast(agents.map((a) => ({ key: "d:" + a.id, a, label: labels.get(a.id) ?? "agent", sub: sessionSub(a) })));
});

// ---- Helpers ----------------------------------------------------------------------

export interface HelperRow {
  key: string;
  label: string;
  running: boolean;
  /** "running 4m", "took 1m 10s", "ended 3m ago" or "finished". */
  figure: string;
}

/** A helper's right-hand figure: how long it has run, as coarse as the
 * Now tab's so it does not tick every second; how long it took, finely;
 * or when it ended when its start is not known. */
export function helperFigure(s: Pick<SubagentRow, "running" | "startedEpoch" | "endedEpoch">): string {
  if (s.running) return withAge("running", ageSince(s.startedEpoch));
  if (s.startedEpoch && s.endedEpoch) return "took " + fmtSpan(Math.max(0, s.endedEpoch - s.startedEpoch));
  const ended = agoText(s.endedEpoch);
  return ended ? "ended " + ended : "finished";
}

/** Every helper run the panel still holds for the selected workspace,
 * running first, then the finished ones newest first, as team.ts ranks
 * them. Finished runs last only as long as their source keeps them. */
export const helperRows = computed((): Last<HelperRow>[] =>
  markLast(subagents().map((s) => ({ key: s.key, label: s.label, running: s.running, figure: helperFigure(s) }))),
);

// ---- Pull request -----------------------------------------------------------------

export interface CheckDetail {
  key: string;
  name: string;
  state: SavedCheck["state"];
  /** "running 3m", "queued 2m", "failed, started 14m ago", "passed". */
  figure: string;
  /** Where a tap goes: the PR's checks page. */
  url: string | undefined;
}

const CHECK_WORD: Record<SavedCheck["state"], string> = { pass: "passed", fail: "failed", pending: "running" };

/**
 * A check's right-hand words. The poller saves when a check was queued and
 * when it started, never when it ended, so a running or queued check says
 * for how long, as coarsely as an age so it does not tick every second,
 * and a finished one says when it started.
 */
export function checkFigure(c: SavedCheck): string {
  if (c.state === "pending") {
    if (c.started) return withAge("running", ageSince(c.started));
    return c.queued ? withAge("queued", ageSince(c.queued)) : "running";
  }
  const started = agoText(c.started);
  return started ? CHECK_WORD[c.state] + ", started " + started : CHECK_WORD[c.state];
}

/** A GitHub PR's checks page; the PR itself for any other link. */
export function checksUrl(url: string | undefined): string | undefined {
  return url && /\/pull\/\d+$/.test(url) ? url + "/checks" : url;
}

/** Every check on the selected workspace's PR, passing ones too, in the
 * poller's order (failing first), each opening the PR's checks page. */
export const checkDetails = computed((): Last<CheckDetail>[] => {
  const ws = cur().ws;
  const pr = prOf(ws);
  const list = checksOf(ws, pr);
  const url = checksUrl(pr?.url);
  return markLast(
    checkRows(list).map((row, i) => {
      const saved = list[i];
      return { ...row, figure: saved ? checkFigure(saved) : "", url };
    }),
  );
});

/**
 * The PR's merge state and size, "Mergeable, no conflicts, +412 −38". The
 * poller sets mergeable and conflicts only while they hold, so a PR with
 * neither says nothing about merging rather than guess; "" with nothing to say.
 */
export function mergeLine(pr: PullRequest | undefined): string {
  if (!pr) return "";
  const parts: string[] = [];
  if (pr.status === "merged") parts.push("Merged");
  else if (pr.status === "closed") parts.push("Closed");
  else if (pr.conflicts) parts.push("Has merge conflicts");
  else if (pr.mergeable) parts.push("Mergeable, no conflicts");
  const diff = diffText(pr);
  if (diff) parts.push(diff);
  return parts.join(", ");
}

/** The selected workspace's PR's merge line. */
export const prMergeLine = computed((): string => mergeLine(prOf(cur().ws)));

// ---- Your move --------------------------------------------------------------------

export interface MoveDetail {
  text: string;
  /** "2 decisions open, leaning 1b 2a"; "" when the reply laid out none. */
  meta: string;
}

/**
 * What the selected workspace's chat ended its turn on, with its open
 * decisions and leans, read through waitingMove, so a move a newer prompt
 * or an ask has retired never shows. Null without a current move, or when
 * the turn asks nothing of Jon ("Nothing for you").
 */
export const moveDetail = computed((): MoveDetail | null => {
  const { a, ws } = cur();
  const m = waitingMove(a, ws, askReason(a, ws) !== null);
  if (!m || asksNothing(m)) return null;
  const n = m.decisions ?? 0;
  const decisions = n > 0 ? (n === 1 ? "1 decision open" : n + " decisions open") : "";
  const leans = m.leans ? "leaning " + m.leans : "";
  return { text: m.text, meta: [decisions, leans].filter(Boolean).join(", ") };
});

// ---- Ports -----------------------------------------------------------------------

export interface PortRow {
  key: string;
  label: string;
  url: string;
}

/** Every open port of the selected workspace, each opening its local page. */
export const portRows = computed((): Last<PortRow>[] =>
  markLast((cur().ws.ports ?? []).map((n) => ({ key: "p" + n, label: ":" + n, url: "http://localhost:" + n }))),
);

// ---- Nothing to show ----------------------------------------------------------------

/** The faint line the Details tab shows in place of its cards: none
 * selected, or a workspace with nothing more to say; "" while any card shows. */
export const detailsNote = computed((): string => {
  if (!current()) return "No workspace selected";
  const lists = [sessionRows(), helperRows(), portRows(), madeOwn()];
  const empty = lists.every((l) => l.length === 0) && !currentPr() && !moveDetail();
  return empty ? "Nothing more to show for this workspace yet" : "";
});
