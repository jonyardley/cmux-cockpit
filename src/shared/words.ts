// An agent's status in words, one copy for both sidebars (issue #82), so a
// finished agent reads "Finished 3m" on each side and never Done or Ended.
// The native card's words are native/core/src/words.rs; the Running words
// here match its own.

import type { SavedCount, TaskType } from "../../scripts/state-config.ts";

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

/** An idle agent whose chat still runs background work of any kind (#359, #360). */
export const RUNNING_WORD = "Running";

// Each kind in words, singular and plural, as words.rs's task_word has
// them: a monitor reads as a shell (it watches a shell command), a kind
// Claude Code adds later as a task.
const TASK_WORDS: Record<TaskType, readonly [string, string]> = {
  shell: ["shell", "shells"],
  monitor: ["shell", "shells"],
  subagent: ["agent", "agents"],
  session: ["session", "sessions"],
  workflow: ["workflow", "workflows"],
  teammate: ["teammate", "teammates"],
  "cloud session": ["cloud session", "cloud sessions"],
  "MCP task": ["MCP task", "MCP tasks"],
  other: ["task", "tasks"],
};

/** One kind of background work in words: "shell", "agents". */
export const taskWord = (type: TaskType, n: number): string => TASK_WORDS[type][n === 1 ? 0 : 1];

/** "· 1 shell, 2 agents": the count of each kind, in the order given; "" for none. */
export function runningText(counts: readonly SavedCount[]): string {
  const words = counts.filter((c) => c.n > 0).map((c) => `${c.n} ${taskWord(c.type, c.n)}`);
  return words.length ? "· " + words.join(", ") : "";
}

/** A working agent with no activity for a while: "Working 42m · quiet 17m". */
export const QUIET_WORD = "quiet";

/** The word and how long it has held, "Finished 3m"; the word alone without an age. */
export const withAge = (word: string, age: string): string => (age ? word + " " + age : word);
