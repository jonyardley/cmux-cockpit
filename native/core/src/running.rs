//! Whether background work runs for a card, and what (issue #359): the
//! one rule the status, Ready, Ready to merge and lane order all read, so
//! they never disagree on it. The quiet rule (`crate::quiet`) keeps to the
//! chat's own agent runs, since this record is written on Stop only.
//!
//! The work is the chat's whole tree as `crate::background::live_tasks`
//! gives it: its shells and monitors, its agents and their own shells,
//! under any session id the chat ran under (`crate::owner`), and nothing
//! once the chat has ended. A `claude --bg` session counts only when a
//! hook saved it against the chat (a `session` entry) and the runner's
//! Agent View list still has it working or blocked
//! (`Data::background_runs`); one Agent View lists but no chat saved
//! never reaches a card. No age limit applies on top: a saved session
//! counts only while the chat that started it is open, so a session left
//! blocked for weeks shows only on a chat that is itself still open.

use crate::background::live_tasks;
use crate::data::{Agent, AgentStatus, Data, Workspace};
use crate::persist::{SavedState, SavedTask, TaskType};

/// The prefix a `claude --bg` session's entry id carries before the short
/// id `claude --bg` printed ("bg:68166394").
const SESSION_PREFIX: &str = "bg:";

/// The background work a card's chat runs.
#[derive(Debug, Clone, PartialEq)]
pub struct Running {
    /// How many run of each kind, in `KIND_ORDER`, none left out at 0.
    /// A monitor counts as a shell, since Claude Code lists it as one.
    pub counts: Vec<(TaskType, usize)>,
    /// When the earliest of them started, in epoch seconds.
    pub since: f64,
}

/// The order kinds are named in, so the words hold still between frames.
const KIND_ORDER: [TaskType; 8] = [
    TaskType::Shell,
    TaskType::Subagent,
    TaskType::Session,
    TaskType::Workflow,
    TaskType::Teammate,
    TaskType::CloudSession,
    TaskType::McpTask,
    TaskType::Other,
];

/// The kind a task counts as: a monitor is a shell.
fn counted_as(kind: TaskType) -> TaskType {
    match kind {
        TaskType::Monitor => TaskType::Shell,
        k => k,
    }
}

/// Whether a saved task still runs: a `claude --bg` session only while
/// the runner's data says so, anything else while it is saved.
fn still_runs(data: &Data, t: &SavedTask) -> bool {
    if t.kind != TaskType::Session {
        return true;
    }
    let id = t.id.strip_prefix(SESSION_PREFIX).unwrap_or(&t.id);
    data.background_runs(id)
}

/// The background work `a`'s chat runs in `w`, or None when none does.
pub fn running_work(
    saved: &SavedState,
    data: &Data,
    w: Option<&Workspace>,
    a: Option<&Agent>,
) -> Option<Running> {
    let live: Vec<&SavedTask> = live_tasks(saved, w, a)
        .into_iter()
        .filter(|t| still_runs(data, t))
        .collect();
    let since = live
        .iter()
        .map(|t| t.started_epoch)
        .min_by(f64::total_cmp)?;
    let counts = KIND_ORDER
        .iter()
        .map(|k| (*k, live.iter().filter(|t| counted_as(t.kind) == *k).count()))
        .filter(|(_, n)| *n > 0)
        .collect();
    Some(Running { counts, since })
}

/// Whether the card says Running: its agent is idle while its chat runs
/// background work. A working agent says Working, a waiting one waits on
/// Jon, and an ended one runs nothing.
pub fn shows_running(a: Option<&Agent>, running: Option<&Running>) -> bool {
    running.is_some() && a.is_some_and(|a| a.status == Some(AgentStatus::Idle))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::data::{BackgroundSession, BackgroundState};

    fn task(id: &str, kind: &str, session: &str, started: f64) -> String {
        format!(
            r#"{{"id": "{id}", "type": "{kind}", "status": "running", "description": "d",
                "session": "{session}", "startedEpoch": {started}, "seenEpoch": 900}}"#
        )
    }

    fn saved(tasks: &[String]) -> SavedState {
        let json = format!(r#"{{"background": {{"w1": [{}]}}}}"#, tasks.join(","));
        SavedState::from_json(&json).unwrap()
    }

    fn chat(id: &str, status: AgentStatus) -> Agent {
        Agent {
            id: id.to_string(),
            status: Some(status),
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

    fn bg(id: &str, state: BackgroundState) -> BackgroundSession {
        BackgroundSession {
            id: id.to_string(),
            state: Some(state),
            ..BackgroundSession::default()
        }
    }

    fn with_sessions(sessions: Vec<BackgroundSession>) -> Data {
        Data {
            background_sessions: Some(sessions),
            ..Data::default()
        }
    }

    #[test]
    fn counts_each_kind_in_a_fixed_order_from_the_earliest_start() {
        let s = saved(&[
            task("a1", "subagent", "c", 300.0),
            task("b1", "shell", "c", 200.0),
            task("m1", "monitor", "c", 400.0),
            task("w1", "workflow", "c", 500.0),
            task("t1", "teammate", "c", 500.0),
            task("cl", "cloud session", "c", 500.0),
            task("mc", "MCP task", "c", 500.0),
            task("x1", "something new", "c", 500.0),
            task("bg:68166394", "session", "c", 150.0),
        ]);
        let a = chat("c", AgentStatus::Idle);
        let w = workspace(std::slice::from_ref(&a));
        let data = with_sessions(vec![bg("68166394", BackgroundState::Working)]);
        let r = running_work(&s, &data, Some(&w), Some(&a));
        assert_eq!(
            r,
            Some(Running {
                counts: vec![
                    (TaskType::Shell, 2),
                    (TaskType::Subagent, 1),
                    (TaskType::Session, 1),
                    (TaskType::Workflow, 1),
                    (TaskType::Teammate, 1),
                    (TaskType::CloudSession, 1),
                    (TaskType::McpTask, 1),
                    (TaskType::Other, 1),
                ],
                since: 150.0,
            })
        );
    }

    #[test]
    fn a_saved_session_counts_while_the_runner_has_it_working_or_blocked() {
        let s = saved(&[task("bg:68166394", "session", "c", 100.0)]);
        let a = chat("c", AgentStatus::Idle);
        let w = workspace(std::slice::from_ref(&a));
        let runs = |data: &Data| running_work(&s, data, Some(&w), Some(&a)).is_some();
        assert!(runs(&with_sessions(vec![bg(
            "68166394",
            BackgroundState::Working
        )])));
        assert!(runs(&with_sessions(vec![bg(
            "68166394",
            BackgroundState::Blocked
        )])));
        for settled in [
            BackgroundState::Done,
            BackgroundState::Failed,
            BackgroundState::Stopped,
        ] {
            assert!(!runs(&with_sessions(vec![bg("68166394", settled)])));
        }
        assert!(!runs(&with_sessions(vec![])), "gone from Agent View");
        assert!(!runs(&Data::default()), "no list from the runner");
    }

    #[test]
    fn a_settled_session_leaves_the_rest_and_the_start_to_the_others() {
        let s = saved(&[
            task("bg:aaaaaaaa", "session", "c", 100.0),
            task("b1", "shell", "c", 300.0),
        ]);
        let a = chat("c", AgentStatus::Idle);
        let w = workspace(std::slice::from_ref(&a));
        let data = with_sessions(vec![bg("aaaaaaaa", BackgroundState::Done)]);
        assert_eq!(
            running_work(&s, &data, Some(&w), Some(&a)),
            Some(Running {
                counts: vec![(TaskType::Shell, 1)],
                since: 300.0
            })
        );
    }

    #[test]
    fn a_blocked_session_no_chat_saved_reaches_no_card() {
        let s = saved(&[]);
        let a = chat("c", AgentStatus::Idle);
        let w = workspace(std::slice::from_ref(&a));
        let data = with_sessions(vec![
            bg("aaaaaaaa", BackgroundState::Blocked),
            bg("bbbbbbbb", BackgroundState::Working),
        ]);
        assert_eq!(running_work(&s, &data, Some(&w), Some(&a)), None);
    }

    #[test]
    fn a_saved_session_stops_counting_once_its_chat_ends() {
        let s = saved(&[task("bg:aaaaaaaa", "session", "c", 100.0)]);
        let a = chat("c", AgentStatus::Ended);
        let w = workspace(std::slice::from_ref(&a));
        let data = with_sessions(vec![bg("aaaaaaaa", BackgroundState::Blocked)]);
        assert_eq!(running_work(&s, &data, Some(&w), Some(&a)), None);
    }

    #[test]
    fn counts_only_the_chats_own_work() {
        let s = saved(&[task("b1", "shell", "other", 100.0)]);
        let a = chat("c", AgentStatus::Idle);
        let b = chat("other", AgentStatus::Working);
        let w = workspace(&[a.clone(), b.clone()]);
        let data = Data::default();
        assert_eq!(running_work(&s, &data, Some(&w), Some(&a)), None);
        assert!(running_work(&s, &data, Some(&w), Some(&b)).is_some());
    }

    #[test]
    fn says_running_only_for_an_idle_agent_with_work() {
        let r = Running {
            counts: vec![(TaskType::Shell, 1)],
            since: 1.0,
        };
        let idle = chat("c", AgentStatus::Idle);
        assert!(shows_running(Some(&idle), Some(&r)));
        assert!(!shows_running(Some(&idle), None));
        assert!(!shows_running(None, Some(&r)));
        for s in [
            AgentStatus::Working,
            AgentStatus::NeedsInput,
            AgentStatus::Ended,
        ] {
            assert!(!shows_running(Some(&chat("c", s)), Some(&r)));
        }
    }
}
