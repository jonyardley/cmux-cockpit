//! An agent's status in words, one copy for both sidebars (issue #82;
//! src/shared/words.ts).

use crate::data::AgentStatus;

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

/// An idle agent whose background shell is still running.
pub const WAITING_WORD: &str = "Waiting";

/// A working agent with no activity for a while.
pub const QUIET_WORD: &str = "quiet";

/// Your last prompt, on a card that shows where you left off.
pub const YOU_WORD: &str = "You";

/// "· 1 shell", "· 2 shells": what an idle agent is waiting on.
pub fn shell_text(n: usize) -> String {
    format!("· {n} {}", if n == 1 { "shell" } else { "shells" })
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
        assert_eq!(shell_text(1), "· 1 shell");
        assert_eq!(shell_text(2), "· 2 shells");
    }
}
