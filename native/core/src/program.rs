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
//!    Claude never reports it blocked. A Stop hook never ends a turn
//!    Claude says is still running: the false hand-back the spike saw.
//! 5. Done or idle: idle, unless a hook asked after Claude's last report
//!    (the idle nudge a minute on, which needs.rs then judges as before),
//!    or a hook said working more than `PROGRAM_GRACE_SECS` after it (a new
//!    turn Claude has not reported yet).
//!
//! A turn that ends on a question in prose still reports done, so whether
//! it waits on Jon stays with the closing line (moves.rs) and the nudge.

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

/// A session's status, when it began and its latest activity, in epoch
/// seconds (0 when unknown).
#[derive(Debug, Clone, PartialEq)]
pub struct Resolved {
    pub status: AgentStatus,
    pub since: f64,
    pub last_activity: f64,
}

impl Resolved {
    fn from(h: &Hooked, last_activity: f64) -> Resolved {
        Resolved {
            status: h.status.clone(),
            since: h.since,
            last_activity,
        }
    }
}

/// The status a card shows, from the session's hooks, its tab's program
/// status (a `Hooked` built from the reports, `last_activity` the latest
/// one) and Agent View's busy, at epoch `now`. None when nothing has said.
pub fn resolve(
    hook: Option<&Hooked>,
    program: Option<&Hooked>,
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
        (None, Some(p)) => Some(Resolved::from(p, p.last_activity)),
        (Some(h), Some(p)) => Some(both(h, p)),
    }
}

/// Rules 2 to 5: which of the hooks and the program status wins.
fn both(h: &Hooked, p: &Hooked) -> Resolved {
    let last_activity = h.last_activity.max(p.last_activity);
    let hook_wins = hook_wins(h, p);
    let winner = if hook_wins { h } else { p };
    Resolved::from(winner, last_activity)
}

fn hook_wins(h: &Hooked, p: &Hooked) -> bool {
    let reported = p.last_activity;
    match (&h.status, &p.status) {
        (AgentStatus::Ended, _) => true,
        (_, AgentStatus::NeedsInput) => false,
        (AgentStatus::NeedsInput, _) => h.last_hook > reported,
        (AgentStatus::Working, AgentStatus::Idle) => h.last_hook > reported + PROGRAM_GRACE_SECS,
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hooked(status: AgentStatus, at: f64) -> Hooked {
        Hooked::after(None, status, at, true, "w")
    }

    fn rec<'a>(id: &'a str, state: &'a str) -> Record<'a> {
        Record { id, state }
    }

    fn status(h: Option<&Hooked>, p: Option<&Hooked>) -> Option<AgentStatus> {
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
        let p = hooked(AgentStatus::Working, 100.0);
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
        let stop = hooked(AgentStatus::Idle, 100.0);
        let working = hooked(AgentStatus::Working, 101.0);
        assert_eq!(
            status(Some(&stop), Some(&working)),
            Some(AgentStatus::Working)
        );
        let late_stop = hooked(AgentStatus::Idle, 160.0);
        assert_eq!(
            status(Some(&late_stop), Some(&working)),
            Some(AgentStatus::Working),
            "only Claude's done ends the turn"
        );
    }

    #[test]
    fn working_keeps_its_first_reports_start() {
        let first = hooked(AgentStatus::Working, 100.0);
        let again = Hooked::after(Some(&first), AgentStatus::Working, 130.0, true, "w");
        let stop = hooked(AgentStatus::Idle, 99.0);
        let r = resolve(Some(&stop), Some(&again), None, 140.0);
        assert_eq!(
            r,
            Some(Resolved {
                status: AgentStatus::Working,
                since: 100.0,
                last_activity: 130.0
            })
        );
    }

    #[test]
    fn a_permission_hook_after_the_last_working_report_needs_input() {
        let working = hooked(AgentStatus::Working, 100.0);
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
        let blocked = hooked(AgentStatus::NeedsInput, 100.0);
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
        let blocked = hooked(AgentStatus::NeedsInput, 100.0);
        let ended = hooked(AgentStatus::Ended, 90.0);
        assert_eq!(
            status(Some(&ended), Some(&blocked)),
            Some(AgentStatus::Ended)
        );
    }

    #[test]
    fn done_then_the_nudge_a_minute_on_keeps_the_hooks_spell() {
        let stop = hooked(AgentStatus::Idle, 100.0);
        let nudge = Hooked::after(Some(&stop), AgentStatus::NeedsInput, 160.0, false, "w");
        let done = hooked(AgentStatus::Idle, 100.4);
        assert_eq!(
            resolve(Some(&nudge), Some(&done), None, 170.0),
            Some(Resolved {
                status: AgentStatus::NeedsInput,
                since: 160.0,
                last_activity: 100.4
            }),
            "the nudge's gap to the last activity still shows"
        );
    }

    #[test]
    fn the_nudge_after_done_still_reads_as_idle_on_the_card_and_blocked_does_not() {
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
        let stop = hooked(AgentStatus::Idle, 100.0);
        let nudge = Hooked::after(Some(&stop), AgentStatus::NeedsInput, 160.0, false, "w");
        let done = hooked(AgentStatus::Idle, 100.4);
        let nudged = resolve(Some(&nudge), Some(&done), None, 170.0);
        assert_eq!(nudged.map(card), Some(crate::status::Status::Idle));
        let blocked = hooked(AgentStatus::NeedsInput, 300.0);
        let asked = resolve(Some(&stop), Some(&blocked), None, 400.0);
        assert_eq!(asked.map(card), Some(crate::status::Status::NeedsInput));
    }

    #[test]
    fn done_after_an_ask_answers_it() {
        let ask = hooked(AgentStatus::NeedsInput, 100.0);
        let done = hooked(AgentStatus::Idle, 130.0);
        assert_eq!(status(Some(&ask), Some(&done)), Some(AgentStatus::Idle));
    }

    #[test]
    fn idle_a_second_after_a_working_hook_is_idle_at_once() {
        let working = hooked(AgentStatus::Working, 100.0);
        let idle = hooked(AgentStatus::Idle, 101.0);
        assert_eq!(
            resolve(Some(&working), Some(&idle), Some(true), 101.0).map(|r| r.status),
            Some(AgentStatus::Idle)
        );
    }

    #[test]
    fn a_working_hook_beats_done_only_past_the_grace() {
        let done = hooked(AgentStatus::Idle, 100.0);
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
        let stop = hooked(AgentStatus::Idle, 100.0);
        let working = hooked(AgentStatus::Working, 100.0);
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
}
