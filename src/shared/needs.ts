// "Needs you", corrected the same way in both sidebars. An agent's
// needs_input reads as idle when it is Claude Code's idle nudge (issue #4) or
// when Jon has dismissed it. The sidebars run in separate contexts, so each
// holds its own dismissals, and a reload forgets them (issues #3 and #5).

/** Seconds between an agent's last activity and a needs_input that is only a nudge. */
export const NUDGE_GAP = 45;

// Claude Code's "Claude is waiting for your input" notification fires about
// 60s after a turn ends, and cmux records it as needs_input (cause not yet
// confirmed, issue #4). A real ask (a permission prompt, a question) begins
// as the agent works, so it follows the agent's last activity closely. A
// nudge begins well after it, with nothing new in between. The workspace's
// latestAt counts as activity too, so if either timestamp moves when the
// nudge lands, the gap closes and the flag shows as before: the rule can
// only fail towards showing needs you.
export function isIdleNudge(a: Agent, w?: Workspace): boolean {
  if (a.status !== "needs_input" || a.kind !== "claude" || !a.sinceEpoch) return false;
  const before = Math.max(a.lastActivityAt ?? 0, w?.latestAt ?? 0);
  return before > 0 && a.sinceEpoch - before >= NUDGE_GAP;
}

// A dismissal is keyed to the workspace and the start of that needs_input
// spell, so a new ask (a new start) shows again. Plain Set, so reads call
// tick() and writes call bump().
const dismissed = new Set<string>();
const [tick, setTick] = signal(0);
const bump = () => setTick(tick() + 1);

const needsStart = (a: Agent): number => a.sinceEpoch || a.lastActivityAt || 0;
const keyOf = (w: Workspace, a: Agent): string => w.id + "@" + needsStart(a);
const asking = (w: Workspace | undefined): Agent[] => (w?.agents ?? []).filter((a) => a?.status === "needs_input");

function isDismissed(w: Workspace | undefined, a: Agent): boolean {
  tick();
  return !!w && a.status === "needs_input" && dismissed.has(keyOf(w, a));
}

/** The agent as the sidebars show it: needs_input reads as idle when it is a nudge or dismissed. */
export function effectiveAgent(a: Agent, w?: Workspace): Agent {
  if (a.status !== "needs_input" || !(isIdleNudge(a, w) || isDismissed(w, a))) return a;
  return { ...a, status: "idle" };
}

/** A workspace's agents with nudges and dismissals applied, in the app's order. */
export function agentsOf(w: Workspace | undefined): Agent[] {
  return (w?.agents ?? []).filter((a) => !!a).map((a) => effectiveAgent(a, w));
}

/** True when Jon has dismissed a needs_input that is still standing. */
export function isNeedsDismissed(w: Workspace | undefined): boolean {
  return asking(w).some((a) => isDismissed(w, a));
}

/** Dismisses every needs_input in the workspace; each comes back when that agent asks again. */
export function dismissNeeds(w: Workspace | undefined): void {
  const list = asking(w);
  if (!w || !list.length) return;
  forget(w);
  for (const a of list) dismissed.add(keyOf(w, a));
  bump();
}

export function restoreNeeds(w: Workspace | undefined): void {
  if (w && forget(w)) bump();
}

// Drops the workspace's dismissals; true when there were any.
function forget(w: Workspace): boolean {
  let any = false;
  for (const k of dismissed) {
    if (!k.startsWith(w.id + "@")) continue;
    dismissed.delete(k);
    any = true;
  }
  return any;
}
