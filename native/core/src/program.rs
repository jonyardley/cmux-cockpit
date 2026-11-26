//! Claude Code's own word on its state (issue #326). Claude sends it as
//! the Program Status Protocol (OSC 7501), and cmux passes it on as a
//! `program_status.changed` event per tab. The runner keeps it beside the
//! hooks, and `resolve` here says which of the two a card believes.
//!
//! | Record state | Status |
//! | --- | --- |
//! | working | working |
//! | blocked, any kind (permission, question, auth or none) | needs input |
//! | done, idle, error | idle |
//!
//! A record for a background task (one with an id) counts only when it is
//! blocked: a helper waiting on Jon is a card waiting on Jon.
//!
//! Which wins when the two disagree:
//!
//! 1. No program status: the hooks, as before, Agent View's stale check too.
//! 2. A hook that ended the session: ended.
//! 3. Blocked: needs input, whatever the hooks say.
//! 4. Working: working, unless a hook asked (needs input) after Claude's
//!    last report, which keeps a permission prompt in Needs you even if
//!    Claude never reports it blocked. A Stop hook alone never ends a turn
//!    Claude says is still running: the false hand-back the spike saw.
//!    The one exception is while Claude's report lists background tasks:
//!    then Claude keeps the session's record at working across the turn's
//!    end and its helpers' tool calls arrive as the chat's hooks, so
//!    neither says the turn ended. There, a Stop after Claude last changed
//!    its word to working, with no prompt since, reads idle from the Stop.
//!    A turn that does go on comes back as a prompt, which clears the
//!    Stop, or as Claude changing to working.
//! 5. Done or idle: idle, unless a hook asked after Claude's last report
//!    (an ask cmux raised from a Notification a minute on, say),
//!    or a hook said working more than `PROGRAM_GRACE_SECS` after it (a new
//!    turn Claude has not reported yet).
//!
//! A turn that ends on a question in prose still reports done, so whether
//! it waits on Jon stays with the closing line (moves.rs).

use crate::data::AgentStatus;
use crate::hooks::{Hooked, status_without_hooks};

/// How much later than Claude's done or idle a working hook must come to
/// win: within it, the two are the same moment seen out of order.
pub const PROGRAM_GRACE_SECS: f64 = 2.0;

/// The status a record's state sets, or None for a state this port does
/// not know. The kind of a blocked record does not change it.
pub fn status_from_program(state: &str) -> Option<AgentStatus> {
    let state = state.split_once(':').map_or(state, |(s, _)| s);
    match state {
        "working" => Some(AgentStatus::Working),
        "blocked" => Some(AgentStatus::NeedsInput),
        "done" | "idle" | "error" => Some(AgentStatus::Idle),
        _ => None,
    }
}

/// One record of a tab's program status, as cmux lists them.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Record<'a> {
    /// "" for the session itself, else a background task's id.
    pub id: &'a str,
    pub state: &'a str,
}

/// The status a tab's records add up to: needs input when any record is
/// blocked, else the session's own record, else None (nothing to say).
pub fn status_of_records(records: &[Record<'_>]) -> Option<AgentStatus> {
    let blocked = records
        .iter()
        .any(|r| status_from_program(r.state) == Some(AgentStatus::NeedsInput));
    if blocked {
        return Some(AgentStatus::NeedsInput);
    }
    records
        .iter()
        .find(|r| r.id.is_empty())
        .and_then(|r| status_from_program(r.state))
}

/// Whether the records list a background task still running: a record
/// with an id whose state is working or blocked. A finished helper's
/// record does not count.
pub fn lists_helpers(records: &[Record<'_>]) -> bool {
    records.iter().any(|r| {
        !r.id.is_empty()
            && matches!(
                status_from_program(r.state),
                Some(AgentStatus::Working | AgentStatus::NeedsInput)
            )
    })
}

/// Claude's latest word for a tab: the status its records add up to,
/// when that status began, and whether its latest records list any
/// background task. Only a change of status moves `since`, so a
/// repeated report, or a helper's progress under the same status, leaves
/// it alone: it is the moment Claude last changed its mind, which is what
/// the hooks are weighed against.
#[derive(Debug, Clone, PartialEq)]
pub struct Report {
    pub status: AgentStatus,
    pub since: f64,
    pub helpers: bool,
}

impl Report {
    /// The report after one at epoch `at` saying `status`, given the last.
    /// `helpers` is whether this report's records list a background task.
    pub fn after(prev: Option<&Report>, status: AgentStatus, helpers: bool, at: f64) -> Report {
        let since = match prev {
            Some(p) if p.status == status => p.since,
            _ => at,
        };
        Report {
            status,
            since,
            helpers,
        }
    }
}

/// A session's status, when it began and its latest activity, in epoch
/// seconds (0 when unknown).
#[derive(Debug, Clone, PartialEq)]
pub struct Resolved {
    pub status: AgentStatus,
    pub since: f64,
    pub last_activity: f64,
}

/// The status a card shows, from the session's hooks, its tab's report
/// and Agent View's busy, at epoch `now`. None when nothing has said.
pub fn resolve(
    hook: Option<&Hooked>,
    program: Option<&Report>,
    busy: Option<bool>,
    now: f64,
) -> Option<Resolved> {
    match (hook, program) {
        (None, None) => status_without_hooks(busy).map(|status| Resolved {
            status,
            since: 0.0,
            last_activity: 0.0,
        }),
        (Some(h), None) => {
            let (status, since) = h.with_agent_view(busy, now);
            Some(Resolved {
                status,
                since,
                last_activity: h.last_activity,
            })
        }
        (None, Some(p)) => Some(Resolved {
            status: p.status.clone(),
            since: p.since,
            last_activity: p.since,
        }),
        (Some(h), Some(p)) => Some(both(h, p)),
    }
}

/// Rules 2 to 5: which of the hooks and the report wins.
fn both(h: &Hooked, p: &Report) -> Resolved {
    let last_activity = h.last_activity.max(p.since);
    let (status, since) = if let Some(stop) = stopped_under_working(h, p) {
        (AgentStatus::Idle, stop)
    } else if hook_wins(h, p) {
        (h.status.clone(), h.since)
    } else {
        (p.status.clone(), p.since)
    };
    Resolved {
        status,
        since,
        last_activity,
    }
}

/// Rule 4's Stop, when it reads idle: Claude says working with
/// background tasks listed, but the chat stopped after Claude last changed
/// to working and no prompt has come since. A hook's ask still comes
/// first, as do an ended session and a blocked report. Some(the Stop).
fn stopped_under_working(h: &Hooked, p: &Report) -> Option<f64> {
    let stop = h.stopped_at?;
    let reads_idle = p.status == AgentStatus::Working
        && p.helpers
        && stop > p.since
        && !matches!(h.status, AgentStatus::Ended | AgentStatus::NeedsInput);
    reads_idle.then_some(stop)
}

/// Rule 2 also holds here, not only in the runner (which hides an ended
/// session before it asks), so any caller of `resolve` gets it.
fn hook_wins(h: &Hooked, p: &Report) -> bool {
    match (&h.status, &p.status) {
        (AgentStatus::Ended, _) => true,
        (_, AgentStatus::NeedsInput) => false,
        (AgentStatus::NeedsInput, _) => h.last_hook > p.since,
        (AgentStatus::Working, AgentStatus::Idle) => h.last_hook > p.since + PROGRAM_GRACE_SECS,
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hooked(status: AgentStatus, at: f64) -> Hooked {
        Hooked::after(None, status, at, true, "w")
    }

    /// A session that hooked Stop at `at`.
    fn stopped(at: f64) -> Hooked {
        hooked(AgentStatus::Idle, at).turn_hook("Stop", at)
    }

    /// Claude's first report, listing only the session's own record.
    fn report(status: AgentStatus, at: f64) -> Report {
        Report::after(None, status, false, at)
    }

    /// Claude's first report, listing background tasks too.
    fn with_helpers(status: AgentStatus, at: f64) -> Report {
        Report::after(None, status, true, at)
    }

    fn rec<'a>(id: &'a str, state: &'a str) -> Record<'a> {
        Record { id, state }
    }

    fn status(h: Option<&Hooked>, p: Option<&Report>) -> Option<AgentStatus> {
        resolve(h, p, None, 1000.0).map(|r| r.status)
    }

    #[test]
    fn maps_each_state_and_blocked_of_any_kind_needs_input() {
        assert_eq!(status_from_program("working"), Some(AgentStatus::Working));
        for s in ["blocked", "blocked:kind=permission", "blocked:kind=auth"] {
            assert_eq!(status_from_program(s), Some(AgentStatus::NeedsInput), "{s}");
        }
        for s in ["done", "idle", "error"] {
            assert_eq!(status_from_program(s), Some(AgentStatus::Idle), "{s}");
        }
        assert_eq!(status_from_program("thinking"), None);
    }

    #[test]
    fn reads_the_sessions_own_record_and_any_blocked_helper() {
        let done = [rec("", "done"), rec("a1", "working")];
        assert_eq!(status_of_records(&done), Some(AgentStatus::Idle));
        let helper_asks = [rec("", "working"), rec("a1", "blocked")];
        assert_eq!(
            status_of_records(&helper_asks),
            Some(AgentStatus::NeedsInput)
        );
        assert_eq!(status_of_records(&[rec("a1", "working")]), None);
        assert_eq!(status_of_records(&[]), None);
    }

    #[test]
    fn with_no_program_status_the_hooks_rule_as_before() {
        let working = hooked(AgentStatus::Working, 100.0);
        assert_eq!(
            resolve(Some(&working), None, Some(false), 200.0),
            Some(Resolved {
                status: AgentStatus::Idle,
                since: 100.0,
                last_activity: 100.0
            }),
            "Agent View's stale check still applies"
        );
        assert_eq!(status(None, None), None);
        assert_eq!(
            resolve(None, None, Some(true), 200.0).map(|r| r.status),
            Some(AgentStatus::Working)
        );
    }

    #[test]
    fn program_status_alone_is_the_status() {
        let p = report(AgentStatus::Working, 100.0);
        assert_eq!(
            resolve(None, Some(&p), Some(false), 900.0),
            Some(Resolved {
                status: AgentStatus::Working,
                since: 100.0,
                last_activity: 100.0
            }),
            "Agent View does not overrule Claude's own word"
        );
    }

    #[test]
    fn a_stop_then_working_a_second_later_is_no_hand_back() {
        let stop = stopped(100.0);
        let working = report(AgentStatus::Working, 101.0);
        assert_eq!(
            status(Some(&stop), Some(&working)),
            Some(AgentStatus::Working)
        );
        let late_stop = stopped(160.0);
        assert_eq!(
            status(Some(&late_stop), Some(&working)),
            Some(AgentStatus::Working),
            "only Claude's done ends the turn"
        );
    }

    #[test]
    fn a_repeated_report_keeps_its_first_start() {
        let first = report(AgentStatus::Working, 100.0);
        let again = Report::after(Some(&first), AgentStatus::Working, false, 130.0);
        assert_eq!(again.since, 100.0);
        let stop = stopped(99.0);
        let r = resolve(Some(&stop), Some(&again), None, 140.0);
        assert_eq!(
            r,
            Some(Resolved {
                status: AgentStatus::Working,
                since: 100.0,
                last_activity: 100.0
            })
        );
        let done = Report::after(Some(&again), AgentStatus::Idle, false, 150.0);
        assert_eq!(done.since, 150.0, "a change of status starts afresh");
    }

    #[test]
    fn a_later_report_of_the_same_status_keeps_the_hooks_ask() {
        // A helper's progress lists the session as working again: the
        // permission hook between still stands.
        let working = report(AgentStatus::Working, 100.0);
        let ask = hooked(AgentStatus::NeedsInput, 100.5);
        let helper = Report::after(Some(&working), AgentStatus::Working, true, 101.0);
        assert_eq!(
            status(Some(&ask), Some(&helper)),
            Some(AgentStatus::NeedsInput)
        );
    }

    #[test]
    fn repeated_done_reports_leave_the_last_activity_alone() {
        let stop = stopped(100.0);
        let ask = Hooked::after(Some(&stop), AgentStatus::NeedsInput, 160.0, false, "w");
        let done = report(AgentStatus::Idle, 100.0);
        let later = Report::after(Some(&done), AgentStatus::Idle, false, 130.0);
        let r = resolve(Some(&ask), Some(&later), None, 170.0);
        assert_eq!(r.map(|r| r.last_activity), Some(100.0));
    }

    #[test]
    fn a_permission_hook_after_the_last_working_report_needs_input() {
        let working = report(AgentStatus::Working, 100.0);
        let ask = hooked(AgentStatus::NeedsInput, 100.5);
        assert_eq!(
            status(Some(&ask), Some(&working)),
            Some(AgentStatus::NeedsInput)
        );
        let older_ask = hooked(AgentStatus::NeedsInput, 99.0);
        assert_eq!(
            status(Some(&older_ask), Some(&working)),
            Some(AgentStatus::Working),
            "answered: Claude reported working since"
        );
    }

    #[test]
    fn blocked_needs_input_whatever_the_hooks_say() {
        let blocked = report(AgentStatus::NeedsInput, 100.0);
        for h in [
            AgentStatus::Working,
            AgentStatus::Idle,
            AgentStatus::NeedsInput,
        ] {
            let hook = hooked(h.clone(), 500.0);
            assert_eq!(
                status(Some(&hook), Some(&blocked)),
                Some(AgentStatus::NeedsInput),
                "{h:?}"
            );
        }
    }

    #[test]
    fn a_hook_that_ends_the_session_wins() {
        let blocked = report(AgentStatus::NeedsInput, 100.0);
        let ended = hooked(AgentStatus::Ended, 90.0);
        assert_eq!(
            status(Some(&ended), Some(&blocked)),
            Some(AgentStatus::Ended)
        );
    }

    #[test]
    fn done_then_an_ask_from_a_notification_a_minute_on_keeps_the_hooks_spell() {
        let stop = stopped(100.0);
        let ask = Hooked::after(Some(&stop), AgentStatus::NeedsInput, 160.0, false, "w");
        let done = report(AgentStatus::Idle, 100.4);
        assert_eq!(
            resolve(Some(&ask), Some(&done), None, 170.0),
            Some(Resolved {
                status: AgentStatus::NeedsInput,
                since: 160.0,
                last_activity: 100.4
            }),
            "the last activity stays the turn's end"
        );
    }

    #[test]
    fn blocked_after_a_stop_reads_as_needs_input_on_the_card() {
        use crate::data::{Agent, Workspace};
        use crate::session::Session;
        let card = |r: Resolved| {
            let a = Agent {
                id: "s".into(),
                kind: Some("claude".into()),
                status: Some(r.status),
                since_epoch: Some(r.since),
                last_activity_at: Some(r.last_activity),
                ..Agent::default()
            };
            let w = Workspace {
                id: "w".into(),
                agents: Some(vec![Some(a)]),
                ..Workspace::default()
            };
            Session::default().status_of(Some(&w))
        };
        let stop = stopped(100.0);
        let blocked = report(AgentStatus::NeedsInput, 300.0);
        let asked = resolve(Some(&stop), Some(&blocked), None, 400.0);
        assert_eq!(asked.map(card), Some(crate::status::Status::NeedsInput));
    }

    #[test]
    fn done_after_an_ask_answers_it() {
        let ask = hooked(AgentStatus::NeedsInput, 100.0);
        let done = report(AgentStatus::Idle, 130.0);
        assert_eq!(status(Some(&ask), Some(&done)), Some(AgentStatus::Idle));
    }

    #[test]
    fn idle_a_second_after_a_working_hook_is_idle_at_once() {
        let working = hooked(AgentStatus::Working, 100.0);
        let idle = report(AgentStatus::Idle, 101.0);
        assert_eq!(
            resolve(Some(&working), Some(&idle), Some(true), 101.0).map(|r| r.status),
            Some(AgentStatus::Idle)
        );
    }

    #[test]
    fn a_working_hook_beats_done_only_past_the_grace() {
        let done = report(AgentStatus::Idle, 100.0);
        let soon = hooked(AgentStatus::Working, 100.0 + PROGRAM_GRACE_SECS);
        assert_eq!(status(Some(&soon), Some(&done)), Some(AgentStatus::Idle));
        let new_turn = hooked(AgentStatus::Working, 103.0);
        assert_eq!(
            status(Some(&new_turn), Some(&done)),
            Some(AgentStatus::Working)
        );
    }

    #[test]
    fn at_the_same_moment_claude_wins() {
        let stop = stopped(100.0);
        let working = report(AgentStatus::Working, 100.0);
        assert_eq!(
            status(Some(&stop), Some(&working)),
            Some(AgentStatus::Working)
        );
        let ask = hooked(AgentStatus::NeedsInput, 100.0);
        assert_eq!(
            status(Some(&ask), Some(&working)),
            Some(AgentStatus::Working)
        );
    }

    #[test]
    fn a_stop_under_a_held_working_report_reads_idle_until_a_prompt() {
        // Live, 2026-11-20: a turn ended on a question while helpers ran.
        // Claude kept the session at working, and the helpers' tool calls
        // came as the chat's own hooks.
        let working = with_helpers(AgentStatus::Working, 50.0);
        let stop = stopped(100.0);
        let held = Report::after(Some(&working), AgentStatus::Working, true, 100.5);
        let r = resolve(Some(&stop), Some(&held), None, 110.0);
        assert_eq!(
            r.map(|r| (r.status, r.since)),
            Some((AgentStatus::Idle, 100.0))
        );
        let helper = Hooked::after(Some(&stop), AgentStatus::Working, 120.0, true, "w")
            .turn_hook("PreToolUse", 120.0);
        assert_eq!(status(Some(&helper), Some(&held)), Some(AgentStatus::Idle));
        let prompt = Hooked::after(Some(&helper), AgentStatus::Working, 130.0, true, "w")
            .turn_hook("UserPromptSubmit", 130.0);
        assert_eq!(
            status(Some(&prompt), Some(&held)),
            Some(AgentStatus::Working)
        );
    }

    #[test]
    fn claude_changing_to_working_after_a_stop_still_wins() {
        let done = with_helpers(AgentStatus::Idle, 90.0);
        let stop = stopped(100.0);
        let back = Report::after(Some(&done), AgentStatus::Working, true, 101.0);
        assert_eq!(status(Some(&stop), Some(&back)), Some(AgentStatus::Working));
    }

    #[test]
    fn an_ask_after_the_stop_still_needs_input() {
        let working = with_helpers(AgentStatus::Working, 50.0);
        let stop = stopped(100.0);
        let ask = Hooked::after(Some(&stop), AgentStatus::NeedsInput, 120.0, true, "w")
            .turn_hook("PermissionRequest", 120.0);
        assert_eq!(
            status(Some(&ask), Some(&working)),
            Some(AgentStatus::NeedsInput)
        );
    }

    #[test]
    fn only_working_or_blocked_helpers_count_as_listed() {
        let finished = [rec("", "working"), rec("a1", "done")];
        assert!(!lists_helpers(&finished));
        assert!(lists_helpers(&[rec("", "working"), rec("a1", "working")]));
        assert!(lists_helpers(&[rec("", "working"), rec("a1", "blocked")]));
        assert!(!lists_helpers(&[rec("", "working")]));
        // A Stop under a held working report with only a finished helper
        // listed stays working, as in a plain turn.
        let working = report(AgentStatus::Working, 50.0);
        let held = Report::after(
            Some(&working),
            AgentStatus::Working,
            lists_helpers(&finished),
            100.5,
        );
        let stop = stopped(100.0);
        assert_eq!(status(Some(&stop), Some(&held)), Some(AgentStatus::Working));
    }

    #[test]
    fn with_no_helpers_listed_a_stop_under_working_stays_working() {
        // Rule 4 as before: a blocking Stop hook in a plain turn keeps
        // the turn going while Claude says working.
        let working = report(AgentStatus::Working, 50.0);
        let held = Report::after(Some(&working), AgentStatus::Working, false, 100.5);
        let stop = stopped(100.0);
        let tool = Hooked::after(Some(&stop), AgentStatus::Working, 120.0, true, "w")
            .turn_hook("PreToolUse", 120.0);
        assert_eq!(status(Some(&stop), Some(&held)), Some(AgentStatus::Working));
        assert_eq!(status(Some(&tool), Some(&held)), Some(AgentStatus::Working));
    }

    #[test]
    fn a_prompt_after_the_stop_reads_working_with_helpers_still_listed() {
        // A task-notification turn fires UserPromptSubmit, seen live.
        let held = with_helpers(AgentStatus::Working, 50.0);
        let stop = stopped(100.0);
        assert_eq!(status(Some(&stop), Some(&held)), Some(AgentStatus::Idle));
        let prompt = Hooked::after(Some(&stop), AgentStatus::Working, 130.0, true, "w")
            .turn_hook("UserPromptSubmit", 130.0);
        assert_eq!(prompt.stopped_at, None);
        assert_eq!(
            status(Some(&prompt), Some(&held)),
            Some(AgentStatus::Working)
        );
    }
}
