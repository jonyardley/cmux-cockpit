// The one rule for when a hook's saved entry (an ask, a move) still
// explains an agent's state. Its own module so needs.ts and move.ts can both
// use it without importing each other.

/**
 * Seconds allowed between a hook's timestamp and cmux's for the same event.
 * A Claude Code hook (an ask, a move) and cmux's own hook fire on one event,
 * so their stamps land within a second or so of each other either way. Small
 * on purpose: an ask from before the agent went back to work must never
 * colour the turn end that follows it, and that takes at least an approval,
 * the tool run and a reply.
 */
export const HOOK_SLACK = 3;

/**
 * A hook's saved entry (an ask, a move) when it explains `a` from `since` on:
 * saved no earlier than `since`, HOOK_SLACK aside, and `a`'s by `owns`. The
 * one place the slack rule lives.
 */
export function savedFor<T extends { epoch: number; session?: string }>(
  saved: T | undefined,
  a: Agent,
  w: Workspace,
  since: number,
  owns: (saved: T, a: Agent, w: Workspace) => boolean,
): T | null {
  return saved && saved.epoch >= since - HOOK_SLACK && owns(saved, a, w) ? saved : null;
}
