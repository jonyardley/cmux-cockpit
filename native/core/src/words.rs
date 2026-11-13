//! An agent's status in words, one copy for both sidebars (issue #82;
//! src/shared/words.ts).

use crate::data::AgentStatus;
use crate::persist::TaskType;

/// The status word for each agent status, as a card head or status line
/// starts. None for a status this port does not know.
pub fn status_word(s: &AgentStatus) -> Option<&'static str> {
    match s {
        AgentStatus::NeedsInput => Some("Your turn"),
        AgentStatus::Working => Some("Working"),
        AgentStatus::Idle => Some("Idle"),
        AgentStatus::Ended => Some("Finished"),
        AgentStatus::Other(_) => None,
    }
}

/// Asking (issue #81): needs_input because the agent stopped on a permission or a question.
pub const ASKING_WORD: &str = "Asking";

pub const NO_AGENT_WORD: &str = "No agent";

/// An idle card whose PR GitHub would merge now (issue #299).
pub const MERGE_READY_WORD: &str = "Ready to merge";

/// An idle agent whose chat still runs background work of any kind (#359).
pub const RUNNING_WORD: &str = "Running";

/// An agent the cockpit put to sleep when its card was parked (#328).
pub const ASLEEP_WORD: &str = "Asleep";

/// A sleeping agent asked to wake, until it shows up again.
pub const WAKING_WORD: &str = "Waking";

/// A working agent with no activity for a while.
pub const QUIET_WORD: &str = "quiet";

/// Your last prompt, on a card that shows where you left off.
pub const YOU_WORD: &str = "You";

/// Before a late wait's age, "waiting 45m", on a card that has waited on
/// Jon for half an hour or more. "Waiting" only ever means waiting on him.
pub const WAITING_WORD: &str = "waiting";

/// One kind of background work in words, singular and plural. A monitor
/// watches a shell command, and Claude Code 2.1.322 listed it as a shell,
/// so it reads as one; a kind Claude Code adds later reads as a task.
pub fn task_word(kind: TaskType, n: usize) -> &'static str {
    let (one, many) = match kind {
        TaskType::Shell | TaskType::Monitor => ("shell", "shells"),
        TaskType::Subagent => ("agent", "agents"),
        TaskType::Session => ("session", "sessions"),
        TaskType::Workflow => ("workflow", "workflows"),
        TaskType::Teammate => ("teammate", "teammates"),
        TaskType::CloudSession => ("cloud session", "cloud sessions"),
        TaskType::McpTask => ("MCP task", "MCP tasks"),
        TaskType::Other => ("task", "tasks"),
    };
    if n == 1 { one } else { many }
}

/// "· 1 shell, 2 agents": the count of each kind an idle agent's chat
/// still runs, in the order given; "" for none.
pub fn running_text(counts: &[(TaskType, usize)]) -> String {
    let words: Vec<String> = counts
        .iter()
        .filter(|(_, n)| *n > 0)
        .map(|(kind, n)| format!("{n} {}", task_word(*kind, *n)))
        .collect();
    if words.is_empty() {
        String::new()
    } else {
        format!("· {}", words.join(", "))
    }
}

/// The word and how long it has held, "Finished 3m"; the word alone without an age.
pub fn with_age(word: &str, age: &str) -> String {
    if age.is_empty() {
        word.to_string()
    } else {
        format!("{word} {age}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn words_a_status_and_its_age() {
        assert_eq!(status_word(&AgentStatus::Ended), Some("Finished"));
        assert_eq!(status_word(&AgentStatus::Other("x".into())), None);
        assert_eq!(with_age("Finished", "3m"), "Finished 3m");
        assert_eq!(with_age("Idle", ""), "Idle");
    }

    #[test]
    fn words_every_kind_of_background_work_one_and_many() {
        let kinds = [
            (TaskType::Shell, "1 shell", "2 shells"),
            (TaskType::Monitor, "1 shell", "2 shells"),
            (TaskType::Subagent, "1 agent", "2 agents"),
            (TaskType::Session, "1 session", "2 sessions"),
            (TaskType::Workflow, "1 workflow", "2 workflows"),
            (TaskType::Teammate, "1 teammate", "2 teammates"),
            (
                TaskType::CloudSession,
                "1 cloud session",
                "2 cloud sessions",
            ),
            (TaskType::McpTask, "1 MCP task", "2 MCP tasks"),
            (TaskType::Other, "1 task", "2 tasks"),
        ];
        for (kind, one, two) in kinds {
            assert_eq!(running_text(&[(kind, 1)]), format!("· {one}"));
            assert_eq!(running_text(&[(kind, 2)]), format!("· {two}"));
        }
    }

    #[test]
    fn lists_each_kind_after_one_dot_and_leaves_out_none() {
        assert_eq!(
            running_text(&[(TaskType::Shell, 1), (TaskType::Subagent, 1)]),
            "· 1 shell, 1 agent"
        );
        assert_eq!(
            running_text(&[
                (TaskType::Shell, 2),
                (TaskType::Subagent, 0),
                (TaskType::Session, 3)
            ]),
            "· 2 shells, 3 sessions"
        );
        assert_eq!(running_text(&[]), "");
        assert_eq!(running_text(&[(TaskType::Shell, 0)]), "");
    }

    /// The sample test/running-save.test.ts reads too, so the agents
    /// panel's words.ts names each kind as the card does (#360).
    #[test]
    fn words_the_shared_sample_as_the_agents_panel_does() {
        use crate::persist::{MAX_COUNTS, MAX_TASKS, SavedCount};

        #[derive(serde::Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Sample {
            counts: Vec<SavedCount>,
            text: String,
        }
        #[derive(serde::Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct File {
            max_counts: usize,
            max_tasks: usize,
            samples: Vec<Sample>,
        }
        let file: File = serde_json::from_str(include_str!("../tests/running-words.json")).unwrap();
        assert_eq!(file.max_counts, MAX_COUNTS);
        assert_eq!(file.max_tasks, MAX_TASKS);
        for s in file.samples {
            let counts: Vec<(TaskType, usize)> = s.counts.iter().map(|c| (c.kind, c.n)).collect();
            assert_eq!(running_text(&counts), s.text);
        }
    }
}
