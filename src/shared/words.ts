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

/** The word and how long it has held, "Finished 3m"; the word alone without an age. */
export const withAge = (word: string, age: string): string => (age ? word + " " + age : word);
