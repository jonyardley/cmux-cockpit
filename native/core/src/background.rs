//! A chat's background work from the saved `background` map: the shells,
//! monitors, agents and their own work Claude Code lists on Stop and
//! SubagentStop, recorded by scripts/hooks/report-background.ts (see
//! docs/state-loop.md, Background work).
//!
//! The hook sees a task end only when a later snapshot leaves it out, so
//! this is the fallback for an end it missed: a task counts only for the
//! chat that owns its session, under any id that chat ran under
//! (`crate::owner`), and only while that chat is open. The chat's process
//! gone ends its work here at once; the hook's prune removes the entry
//! from the file later, since the core never writes this map.
//!
//! Nothing reads this yet: the card's status and words take it up in a
//! later change (#359).

use crate::data::{Agent, AgentStatus, Workspace};
use crate::owner::owns;
use crate::persist::{SavedState, SavedTask};

/// The background tasks `a`'s chat has running in workspace `w`, in the
/// order saved; none once the chat has ended.
pub fn live_tasks<'s>(
    saved: &'s SavedState,
    w: Option<&Workspace>,
    a: Option<&Agent>,
) -> Vec<&'s SavedTask> {
    let (Some(w), Some(a)) = (w, a) else {
        return Vec::new();
    };
    if a.status == Some(AgentStatus::Ended) {
        return Vec::new();
    }
    // The same agents a saved shell is matched against (`crate::shells`):
    // those cmux reports a status for.
    let agents = w.agent_list().filter(|x| x.status.is_some());
    saved.background.get(&w.id).map_or_else(Vec::new, |tasks| {
        tasks
            .iter()
            .filter(|t| owns(agents.clone(), a, &t.session))
            .collect()
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::persist::TaskType;

    const STATE: &str = r#"{"background": {"w1": [
        {"id": "b1", "type": "shell", "status": "running", "description": "build",
         "session": "now", "startedEpoch": 10, "seenEpoch": 20},
        {"id": "a1", "type": "subagent", "status": "running", "description": "review",
         "session": "before", "startedEpoch": 10, "seenEpoch": 20},
        {"id": "b2", "type": "shell", "status": "running", "description": "tests",
         "session": "other", "startedEpoch": 10, "seenEpoch": 20}
    ]}}"#;

    fn agent(id: &str, status: Option<AgentStatus>, earlier: &[&str]) -> Agent {
        Agent {
            id: id.to_string(),
            status,
            earlier_sessions: (!earlier.is_empty())
                .then(|| earlier.iter().map(|s| (*s).to_string()).collect()),
            ..Agent::default()
        }
    }

    fn workspace(agents: &[Agent]) -> Workspace {
        Workspace {
            id: "w1".to_string(),
            agents: Some(agents.iter().cloned().map(Some).collect()),
            ..Workspace::default()
        }
    }

    fn ids(tasks: &[&SavedTask]) -> Vec<String> {
        tasks.iter().map(|t| t.id.clone()).collect()
    }

    #[test]
    fn a_chat_counts_its_own_tasks_and_those_from_before_a_clear() {
        let saved = SavedState::from_json(STATE).unwrap();
        let a = agent("now", Some(AgentStatus::Idle), &["before"]);
        let b = agent("other", Some(AgentStatus::Working), &[]);
        let w = workspace(&[a.clone(), b.clone()]);
        assert_eq!(ids(&live_tasks(&saved, Some(&w), Some(&a))), ["b1", "a1"]);
        assert_eq!(ids(&live_tasks(&saved, Some(&w), Some(&b))), ["b2"]);
        assert_eq!(
            live_tasks(&saved, Some(&w), Some(&a))
                .iter()
                .map(|t| t.kind)
                .collect::<Vec<_>>(),
            [TaskType::Shell, TaskType::Subagent]
        );
    }

    #[test]
    fn a_closed_chat_counts_nothing() {
        let saved = SavedState::from_json(STATE).unwrap();
        let ended = agent("now", Some(AgentStatus::Ended), &["before"]);
        let w = workspace(std::slice::from_ref(&ended));
        assert!(live_tasks(&saved, Some(&w), Some(&ended)).is_empty());
        assert!(live_tasks(&saved, Some(&w), None).is_empty());
        assert!(live_tasks(&saved, None, Some(&ended)).is_empty());
    }

    #[test]
    fn a_session_no_open_chat_owns_counts_for_no_one() {
        let saved = SavedState::from_json(STATE).unwrap();
        let a = agent("new", Some(AgentStatus::Idle), &[]);
        let w = workspace(std::slice::from_ref(&a));
        assert!(live_tasks(&saved, Some(&w), Some(&a)).is_empty());
    }
}
