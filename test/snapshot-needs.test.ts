// Scene: the Next button and the Needs you strip, capped at four rows with
// "+N more", one of them asking and two quoting their saved move. Fixture data only; see test/support/snapshot.ts.

import { it } from "node:test";
import { ago, EPOCH, seed, snapshotScene } from "./support/snapshot.ts";

const r = seed({
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
});
const { agent, ws } = await import("./support/fixtures.ts");
await import("../src/cockpit/index.ts");
const { C } = await import("../src/cockpit/theme.ts");
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

it("needs you and next", () => {
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
  snapshotScene("needs-and-next", r, C, "cockpit");
});
