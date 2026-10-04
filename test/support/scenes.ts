// The cockpit scenes the model draws, as fixture data: what each one seeds
// before the sidebar loads (saved state, project table) and the cmux data it
// sets after. The snapshot tests print each scene's view tree from these, and
// the golden tests write what the model computes for them, so both read the
// one copy. Every fixture is built inside data(), never at load, so the
// fixture ids (a1, a2, ...) run in the same order however a file imports
// this.

import type { SavedPr } from "../../scripts/state-config.ts";
import { agent, group, ws } from "./fixtures.ts";
import type { Renderer } from "./renderer.ts";
import { ago, EPOCH, type Seed } from "./snapshot.ts";

export interface Scene {
  /** What seed() takes: the saved state and project table, read at load. */
  seed: Seed;
  /** Sets the scene's cmux data on the fake renderer, after the sidebar loads. */
  data: (r: Renderer) => void;
}

// --- lanes ---------------------------------------------------------------------------

// The lanes with a card in every state, each lane at its own density, a
// merged card in Main activity and in Unsorted, a working card under the
// folded Parked header, and one waiting on a background shell.
const lanes: Scene = {
  seed: {
    state: {
      asking: { asking: { reason: "allow git push?", epoch: EPOCH - 120 } },
      subagents: {},
      shells: { waiting: [{ id: "b1", session: "shell-chat", startedEpoch: EPOCH - 300 }] },
    },
  },
  data: (r) => {
    r.data.groups = [
      group("g-main", "Main activity", { anchorId: "anchor-main" }),
      group("g-review", "For review", { anchorId: "anchor-review" }),
      group("g-bg", "Background", { anchorId: "anchor-bg" }),
      group("g-parked", "Parked", { anchorId: "anchor-parked" }),
    ];
    r.data.selectedId = "selected";
    r.data.workspaces = [
      ws("anchor-main", { title: "Main activity", group: "g-main" }),
      ws("needs", {
        title: "Chip colours",
        group: "g-main",
        agents: [agent("needs_input", { sinceEpoch: ago(300), lastActivityAt: ago(300) })],
        latestMessage: "Which green should the ready chip use?",
      }),
      ws("asking", {
        title: "Release notes",
        group: "g-main",
        agents: [agent("needs_input", { sinceEpoch: ago(120), lastActivityAt: ago(120) })],
      }),
      ws("working", {
        title: "Snapshot tests",
        group: "g-main",
        branch: "snapshot-tests",
        dirty: true,
        pr: {
          number: 130,
          status: "open",
          draft: true,
          url: "https://github.com/o/r/pull/130",
          additions: 342,
          deletions: 17,
        },
        agents: [
          agent("working", {
            sinceEpoch: ago(840),
            lastActivityAt: ago(30),
            children: [{ id: "run1", label: "Explore views", running: true, startedEpoch: ago(60) }],
          }),
        ],
        progress: { value: 0.4, label: "Tests" },
        latestMessage: "Recording the view tree as text.",
      }),
      ws("quiet", {
        title: "Long build",
        group: "g-main",
        agents: [agent("working", { sinceEpoch: ago(2400), lastActivityAt: ago(1020) })],
      }),
      ws("ready", {
        title: "Tidy strip",
        group: "g-main",
        unread: 2,
        agents: [agent("idle", { sinceEpoch: ago(360), lastActivityAt: ago(360) })],
        latestMessage: "Done: the strip now groups by repo.",
      }),
      // Merged: dimmed, its branch left out for Park and Close.
      ws("merged", {
        title: "Card layout fit",
        group: "g-main",
        branch: "card-layout-fit",
        pr: { number: 176, status: "merged", url: "https://github.com/o/r/pull/176" },
        agents: [agent("idle", { sinceEpoch: ago(900), lastActivityAt: ago(900) })],
      }),
      // No time in its status line, so the full card keeps the age top right.
      ws("untimed", {
        title: "Untimed card",
        group: "g-main",
        pinned: true,
        latestAt: ago(300),
        agents: [agent("idle")],
      }),
      ws("selected", {
        title: "Selected card",
        group: "g-main",
        selected: true,
        agents: [agent("working", { sinceEpoch: ago(60), lastActivityAt: ago(10) })],
      }),
      ws("anchor-review", { title: "For review", group: "g-review" }),
      ws("ended", {
        title: "Ended agent",
        group: "g-review",
        pinned: true,
        agents: [agent("ended", { sinceEpoch: ago(900), lastActivityAt: ago(900) })],
      }),
      ws("idle", {
        title: "Left off",
        group: "g-review",
        unread: 1,
        latestPrompt: "Look at the merge verdicts next",
        agents: [agent("idle", { sinceEpoch: ago(5000) })],
      }),
      ws("anchor-bg", { title: "Background", group: "g-bg" }),
      ws("none", { title: "No agent", group: "g-bg", branch: "main" }),
      // Idle on a background shell still running: Waiting in working blue.
      ws("waiting", {
        title: "Iteration timings",
        group: "g-bg",
        latestPrompt: "hi",
        agents: [agent("idle", { id: "shell-chat", sinceEpoch: ago(240), lastActivityAt: ago(240) })],
        latestMessage: "The batch resumes by itself once load drops.",
      }),
      ws("anchor-parked", { title: "Parked", group: "g-parked" }),
      // Working under the folded Parked header, so the header shows its dot.
      ws("parked", {
        title: "Parked card",
        group: "g-parked",
        agents: [agent("working", { sinceEpoch: ago(300), lastActivityAt: ago(5) })],
      }),
      ws("loose-merged", {
        title: "Merged elsewhere",
        branch: "tidy-strip",
        pr: { number: 171, status: "merged", url: "https://github.com/o/r/pull/171" },
      }),
      ws("loose", {
        title: "Loose workspace",
        // A project match, so a row's badge is recorded in a project's colour, not only Other's.
        directory: "/Users/coder/dev/app-one",
        pinned: true,
        agents: [agent("working", { sinceEpoch: ago(200), lastActivityAt: ago(20) })],
      }),
    ];
  },
};

// --- needs-and-next --------------------------------------------------------------------

// latestAt is the prompt that began the turn, two minutes before it ended,
// so each saved move (epoch at the turn end) is newer than it. Each agent is
// the Claude session that saved its workspace's move.
const waiting = (id: string, title: string, secs: number, latestMessage?: string): Workspace =>
  ws(id, {
    title,
    agents: [agent("needs_input", { id: "s-" + id, kind: "claude", sinceEpoch: ago(secs), lastActivityAt: ago(secs) })],
    latestAt: ago(secs + 120),
    ...(latestMessage ? { latestMessage } : {}),
  });

// The Next button and the Needs you strip, capped at four rows with
// "+N more", one of them asking and two quoting their saved move.
const needsAndNext: Scene = {
  seed: {
    state: {
      asking: { ask: { reason: "allow npm publish?", epoch: EPOCH - 60 } },
      moves: {
        n2: {
          text: 'reply "1b 2a" on the bridge and the store.',
          epoch: EPOCH - 900,
          session: "s-n2",
          decisions: 2,
          leans: "1b 2a",
        },
        n3: { text: "the work is finished. Run /clear now.", epoch: EPOCH - 600, session: "s-n3" },
      },
    },
  },
  data: (r) => {
    r.data.workspaces = [
      waiting("n1", "Oldest question", 1800, "Should the strip cap at four?"),
      waiting("ask", "Publish", 60),
      waiting("n2", "Second", 900, "Tests pass. Merge now?"),
      waiting("n3", "Third", 600),
      waiting("n4", "Fifth, past the cap", 30, "One more thing"),
      ws("ready", {
        title: "Finished while away",
        unread: 3,
        agents: [agent("idle", { sinceEpoch: ago(240), lastActivityAt: ago(240) })],
      }),
      ws("busy", { title: "Busy", agents: [agent("working", { sinceEpoch: ago(100), lastActivityAt: ago(5) })] }),
    ];
  },
};

// --- projects ---------------------------------------------------------------------------

// The Projects view, with cards grouped under two projects, one card outside
// any project, one card quoting its saved move, a merged card offering Park
// and Close, and the third project folded into the quiet list.
const projects: Scene = {
  seed: {
    state: {
      ui: { mode: "projects" },
      moves: { "one-b": { text: "Read the draft in #142 and say go.", epoch: ago(90), session: "s-one-b" } },
    },
  },
  data: (r) => {
    r.data.workspaces = [
      ws("one-a", {
        title: "One: parser rewrite for the streaming tokeniser",
        directory: "/Users/jon/dev/app-one",
        branch: "parser-streaming-tokeniser",
        pr: {
          number: 148,
          status: "open",
          draft: true,
          url: "https://github.com/o/r/pull/148",
          additions: 342,
          deletions: 17,
        },
        agents: [agent("working", { sinceEpoch: ago(420), lastActivityAt: ago(15) })],
      }),
      ws("one-b", {
        title: "One: docs",
        directory: "/Users/jon/dev/app-one/docs",
        latestAt: ago(150),
        agents: [agent("needs_input", { id: "s-one-b", kind: "claude", sinceEpoch: ago(90), lastActivityAt: ago(90) })],
      }),
      ws("two", {
        title: "Two: release",
        directory: "/Users/jon/.config/app-two",
        branch: "main",
        pr: { number: 12, status: "open", url: "https://github.com/o/r/pull/12" },
        unread: 1,
        pinned: true,
        agents: [agent("idle", { sinceEpoch: ago(600), lastActivityAt: ago(600) })],
      }),
      ws("two-merged", {
        title: "Two: changelog",
        directory: "/Users/jon/.config/app-two",
        branch: "changelog-for-release",
        pr: { number: 14, status: "merged", url: "https://github.com/o/r/pull/14" },
        agents: [agent("idle", { sinceEpoch: ago(900), lastActivityAt: ago(900) })],
      }),
      ws("elsewhere", { title: "Scratch", directory: "/tmp/scratch" }),
    ];
  },
};

// --- review-verdicts ----------------------------------------------------------------------

const pass = [{ name: "build", state: "pass" as const }];
const pr = (number: number, extra: Partial<SavedPr> = {}): SavedPr => ({
  url: `https://github.com/o/r/pull/${number}`,
  number,
  status: "open",
  branch: `feat-${number}`,
  title: `Feature ${number}`,
  checks: pass,
  ...extra,
});

const PRS: Record<string, SavedPr> = {
  ready: pr(1, { mergeable: true, additions: 120, deletions: 8 }),
  draft: pr(2, { mergeable: true, draft: true, additions: 1234, deletions: 56 }),
  failing: pr(3, { mergeable: true, checks: [{ name: "build", state: "fail" }] }),
  running: pr(4, { checks: [{ name: "build", state: "pending" }] }),
  conflicts: pr(5, { conflicts: true }),
  blocked: pr(6),
  merged: pr(7, { status: "merged" }),
  closed: pr(8, { status: "closed" }),
  waiting: pr(9, { mergeable: true }),
};

// The For review lane with a card for each merge verdict, and its header's
// "N ready to merge", under a Main activity card whose PR is ready: it stays
// there, offering a green "To review →".
const reviewVerdicts: Scene = {
  seed: { state: { prs: PRS } },
  data: (r) => {
    r.data.groups = [
      group("g-main", "Main activity", { anchorId: "anchor-main" }),
      group("g-review", "For review", { anchorId: "anchor-review" }),
    ];
    const { waiting: _, ...verdicts } = PRS;
    r.data.workspaces = [
      ws("anchor-main", { title: "Main activity", group: "g-main" }),
      ws("waiting", { title: "waiting card", group: "g-main", branch: "feat-9" }),
      ws("anchor-review", { title: "For review", group: "g-review" }),
      ...Object.entries(verdicts).map(([id, p]) =>
        ws(id, { title: `${id} card`, group: "g-review", branch: p.branch }),
      ),
    ];
  },
};

/** The cockpit scenes the model draws, by the scene name their snapshot and golden files carry. */
export const SCENES = {
  lanes,
  "needs-and-next": needsAndNext,
  projects,
  "review-verdicts": reviewVerdicts,
} satisfies Record<string, Scene>;

export type SceneName = keyof typeof SCENES;
