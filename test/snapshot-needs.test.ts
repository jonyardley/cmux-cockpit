// Scene: the Next button and the Needs you strip, capped at four rows with
// "+N more", one of them asking. Fixture data only; see test/support/snapshot.ts.

import { it } from "node:test";
import { ago, EPOCH, seed, snapshotScene } from "./support/snapshot.ts";

const r = seed({ state: { asking: { ask: { reason: "allow npm publish?", epoch: EPOCH - 60 } } } });
const { agent, ws } = await import("./support/fixtures.ts");
await import("../src/cockpit/index.ts");
const { C } = await import("../src/cockpit/theme.ts");
const waiting = (id: string, title: string, secs: number, latestMessage?: string): Workspace =>
  ws(id, {
    title,
    agents: [agent("needs_input", { sinceEpoch: ago(secs), lastActivityAt: ago(secs) })],
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
  snapshotScene("needs-and-next", r, C);
});
