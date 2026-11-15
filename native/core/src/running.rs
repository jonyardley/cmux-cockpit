//! Whether background work runs for a card, and what (issue #359): the
//! one rule the status, Ready, Ready to merge and lane order all read, so
//! they never disagree on it. The quiet rule (`crate::quiet`) keeps to the
//! chat's own agent runs, since this record is written on Stop only.
//!
//! The work is the chat's whole tree as `crate::background::live_tasks`
//! gives it: its shells and monitors, its agents and their own shells,
//! under any session id the chat ran under (`crate::owner`), and nothing
//! once the chat has ended, less any artifact watch (the monitor the
//! Artifact tool leaves waiting for comments on a published page, which
//! is not work: `artifact_watch`). A `claude --bg` session counts only when a
//! hook saved it against the chat (a `session` entry) and the runner's
//! Agent View list still has it working or blocked
//! (`Data::background_runs`); one Agent View lists but no chat saved
//! never reaches a card. No age limit applies on top: a saved session
//! counts only while the chat that started it is open, so a session left
//! blocked for weeks shows only on a chat that is itself still open.
//!
//! Every other task counts only while it is fresh (#371): the record is
//! refreshed by a Stop alone, so a task whose end never woke its chat
//! would otherwise hold the card on Running for as long as the chat stays
//! open. A task no snapshot has listed for `MAX_AGE_S` has ended, as the
//! hook's prune says (`scripts/hooks/report-background.ts`), and a
//! monitor sooner, by its own deadline (`MONITOR_MAX_AGE_S`).

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
    /// A monitor counts as a shell: it watches a command, and Claude Code
    /// 2.1.322 listed it as one.
    pub counts: Vec<(TaskType, usize)>,
    /// When the earliest of them started, in epoch seconds.
    pub since: f64,
}

impl Running {
    /// Whether it counts any of the chat's agents, so the card's status
    /// line already says them.
    pub fn counts_agents(&self) -> bool {
        self.counts
            .iter()
            .any(|(k, n)| *k == TaskType::Subagent && *n > 0)
    }
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

/// How long a task no snapshot has listed still counts, in seconds: the
/// hook's prune age (`MAX_AGE_S` in scripts/hooks/report-background.ts),
/// so the card lets go of a task when the file would. Both are pinned to
/// native/core/tests/running-words.json.
pub const MAX_AGE_S: f64 = 12.0 * 60.0 * 60.0;

/// How long a monitor no snapshot has listed still counts, in seconds.
/// Claude Code kills every monitor at its deadline, at most 30 minutes
/// after it started, and a task is never seen before it starts, so 30
/// minutes past `seenEpoch` is never before the deadline. The five
/// minutes on top cover the hook's clock against the frame's and the
/// paced rebuild. A monitor an older Claude Code saved as `shell` keeps
/// the shell's limit.
pub const MONITOR_MAX_AGE_S: f64 = 35.0 * 60.0;

/// Whether a saved task was listed recently enough to count at `now`, the
/// frame's clock: within its kind's limit, or always before the first
/// tick or with a stamp ahead of the clock. Kept while `now - seenEpoch`
/// is at most the limit, as the hook's prune keeps it.
fn fresh(t: &SavedTask, now: Option<f64>) -> bool {
    let limit = match t.kind {
        TaskType::Monitor => MONITOR_MAX_AGE_S,
        _ => MAX_AGE_S,
    };
    now.is_none_or(|now| now - t.seen_epoch <= limit)
}

/// How Claude Code describes the monitor the Artifact tool starts when a
/// chat publishes or reopens a page ("live updates for artifact
/// https://claude.ai/artifact/... (auto-armed on publish)").
const ARTIFACT_WATCH_PREFIX: &str = "live updates for artifact ";

/// Whether a saved task is an artifact watch: a monitor that waits for
/// comments on a page the chat published, for as long as the chat stays
/// open. It is not work the chat is doing, so it never holds a card on
/// Running.
fn artifact_watch(t: &SavedTask) -> bool {
    t.kind == TaskType::Monitor && t.description.starts_with(ARTIFACT_WATCH_PREFIX)
}

/// Whether a saved task still runs: a `claude --bg` session only while
/// the runner's data says so, at any age; anything else while it is fresh.
fn still_runs(data: &Data, t: &SavedTask) -> bool {
    if t.kind != TaskType::Session {
        return fresh(t, data.epoch);
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
        .filter(|t| !artifact_watch(t) && still_runs(data, t))
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
    /// A task of `kind` last listed at `seen`, started an hour before.
    fn seen(id: &str, kind: &str, seen: f64) -> String {
        let started = seen - 3600.0;
        format!(
            r#"{{"id": "{id}", "type": "{kind}", "status": "running", "description": "d",
                "session": "c", "startedEpoch": {started}, "seenEpoch": {seen}}}"#
        )
    }

    const NOW: f64 = 1_794_553_000.0;
    const MINUTE: f64 = 60.0;
    const HOUR: f64 = 3600.0;

    fn at(now: f64) -> Data {
        Data {
            epoch: Some(now),
            ..Data::default()
        }
    }

    /// Whether a lone task of `kind`, last listed `ago` seconds before
    /// NOW, holds an idle card on Running.
    fn counts_after(kind: &str, ago: f64) -> bool {
        let s = saved(&[seen("t1", kind, NOW - ago)]);
        let a = chat("c", AgentStatus::Idle);
        let w = workspace(std::slice::from_ref(&a));
        running_work(&s, &at(NOW), Some(&w), Some(&a)).is_some()
    }

    fn described(id: &str, kind: &str, description: &str, start: f64) -> String {
        format!(
            r#"{{"id": "{id}", "type": "{kind}", "status": "running",
                "description": "{description}", "session": "c",
                "startedEpoch": {start}, "seenEpoch": {seen}}}"#,
            seen = NOW - MINUTE,
        )
    }

    #[test]
    fn an_artifact_watch_never_holds_the_card_on_running() {
        let watch = "live updates for artifact https://claude.ai/artifact/9WmDG6FAxeCh7H3fbZ2PmK (auto-armed on publish)";
        let a = chat("c", AgentStatus::Idle);
        let w = workspace(std::slice::from_ref(&a));
        let alone = saved(&[described("m1", "monitor", watch, NOW - HOUR)]);
        assert_eq!(running_work(&alone, &at(NOW), Some(&w), Some(&a)), None);
        // The watch started first, so `since` shows it is left out.
        let beside = saved(&[
            described("m1", "monitor", watch, NOW - HOUR),
            described("m2", "monitor", "tail -f build.log", NOW - 10.0 * MINUTE),
        ]);
        assert_eq!(
            running_work(&beside, &at(NOW), Some(&w), Some(&a)),
            Some(Running {
                counts: vec![(TaskType::Shell, 1)],
                since: NOW - 10.0 * MINUTE,
            })
        );
    }

    #[test]
    fn a_shell_described_like_an_artifact_watch_still_counts() {
        let s = saved(&[described(
            "b1",
            "shell",
            "live updates for artifact x",
            NOW - HOUR,
        )]);
        let a = chat("c", AgentStatus::Idle);
        let w = workspace(std::slice::from_ref(&a));
        assert!(running_work(&s, &at(NOW), Some(&w), Some(&a)).is_some());
    }

    #[test]
    fn a_monitor_counts_until_its_deadline_has_surely_passed() {
        assert!(counts_after("monitor", 10.0 * MINUTE));
        assert!(counts_after("monitor", MONITOR_MAX_AGE_S));
        assert!(!counts_after("monitor", MONITOR_MAX_AGE_S + 1.0));
        assert!(!counts_after("monitor", 17.0 * HOUR), "issue #371");
    }

    #[test]
    fn any_other_task_counts_for_the_hooks_prune_age() {
        for kind in ["shell", "subagent", "workflow", "something new"] {
            assert!(counts_after(kind, 11.0 * HOUR), "{kind}");
            assert!(counts_after(kind, MAX_AGE_S), "{kind}");
            assert!(!counts_after(kind, 13.0 * HOUR), "{kind}");
        }
    }

    #[test]
    fn every_task_counts_before_the_first_tick_or_with_a_stamp_ahead() {
        let s = saved(&[seen("m1", "monitor", NOW - 17.0 * HOUR)]);
        let a = chat("c", AgentStatus::Idle);
        let w = workspace(std::slice::from_ref(&a));
        assert!(running_work(&s, &Data::default(), Some(&w), Some(&a)).is_some());
        assert!(running_work(&s, &at(0.0), Some(&w), Some(&a)).is_some());
        assert!(counts_after("monitor", -5.0 * MINUTE));
    }

    #[test]
    fn a_saved_session_counts_at_any_age_while_the_runner_has_it() {
        let s = saved(&[seen("bg:68166394", "session", NOW - 30.0 * HOUR)]);
        let a = chat("c", AgentStatus::Idle);
        let w = workspace(std::slice::from_ref(&a));
        let data = Data {
            epoch: Some(NOW),
            ..with_sessions(vec![bg("68166394", BackgroundState::Working)])
        };
        assert!(running_work(&s, &data, Some(&w), Some(&a)).is_some());
    }

    #[test]
    fn a_stale_task_leaves_the_counts_and_the_start_to_the_fresh_ones() {
        // The stale monitor started first, so `since` shows it is left out.
        let s = saved(&[
            seen("m1", "monitor", NOW - 17.0 * HOUR),
            seen("b1", "shell", NOW - 10.0 * MINUTE),
        ]);
        let a = chat("c", AgentStatus::Idle);
        let w = workspace(std::slice::from_ref(&a));
        assert_eq!(
            running_work(&s, &at(NOW), Some(&w), Some(&a)),
            Some(Running {
                counts: vec![(TaskType::Shell, 1)],
                since: NOW - 10.0 * MINUTE - HOUR,
            })
        );
    }

    /// The hook's prune ages (scripts/hooks/report-background.ts) are
    /// pinned to the same sample, so the card and the file let go of a
    /// task together.
    #[test]
    fn keeps_to_the_hooks_prune_ages() {
        let file: serde_json::Value =
            serde_json::from_str(include_str!("../tests/running-words.json")).unwrap();
        assert_eq!(file["maxAgeS"].as_f64(), Some(MAX_AGE_S));
        assert_eq!(file["monitorMaxAgeS"].as_f64(), Some(MONITOR_MAX_AGE_S));
    }

    #[test]
    fn says_it_counts_agents_only_with_an_agent_among_its_kinds() {
        let shells = Running {
            counts: vec![(TaskType::Shell, 2)],
            since: 1.0,
        };
        assert!(!shells.counts_agents());
        let both = Running {
            counts: vec![(TaskType::Shell, 1), (TaskType::Subagent, 1)],
            since: 1.0,
        };
        assert!(both.counts_agents());
    }
}
