// An agent's status in words, one copy for both sidebars (issue #82), so a
// finished agent reads "Finished 3m" on each side and never Done or Ended.

/** The status word for each agent status, as a card head or status line starts. */
export const STATUS_WORD: Record<AgentStatus, string> = {
  needs_input: "Your turn",
  working: "Working",
  idle: "Idle",
  ended: "Finished",
};

/** Asking (issue #81): needs_input because the agent stopped on a permission or a question. */
export const ASKING_WORD = "Asking";

export const NO_AGENT_WORD = "No agent";

/** An idle agent whose background shell is still running: "Waiting 4m · 1 shell". */
export const WAITING_WORD = "Waiting";

/** "· 1 shell", "· 2 shells": what an idle agent is waiting on. */
export const shellText = (n: number): string => "· " + n + (n === 1 ? " shell" : " shells");

/** A working agent with no activity for a while: "Working 42m · quiet 17m". */
export const QUIET_WORD = "quiet";

/** Your last prompt, on a card that shows where you left off: "You: tighten slides 9 to 12". */
export const YOU_WORD = "You";

/** The word and how long it has held, "Finished 3m"; the word alone without an age. */
export const withAge = (word: string, age: string): string => (age ? word + " " + age : word);
