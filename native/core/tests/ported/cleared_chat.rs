//! Work a chat started before `/clear` keeps counting on its card (#358):
//! the clear gives the chat a new session id in the same process, the
//! runner hands the core the ids that process ran under before, and the
//! card counts a shell or background agent saved under any of them until
//! it ends.

use cockpit_core::data::{Agent, Data};
use cockpit_core::session::Session;

use crate::support::*;

const NOW: f64 = 1_000_000.0;

const STATE: &str = r#"{
    "shells": {
        "shell": [{"id": "b1", "session": "before", "startedEpoch": 100}],
        "both": [{"id": "b1", "session": "before", "startedEpoch": 100}]
    },
    "subagents": {
        "helper": [{"id": "t1", "session": "before", "label": "Checks", "startedEpoch": 100}],
        "helperDone": [{"id": "t1", "session": "before", "label": "Checks", "startedEpoch": 100, "endedEpoch": 200}],
        "both": [{"id": "t1", "session": "before", "label": "Checks", "startedEpoch": 100}]
    }
}"#;

fn setup() -> (Session, Data, Fx) {
    (session(STATE), frame(NOW, vec![], vec![]), Fx::default())
}

/// The chat idle 4m under `id`, its process having run `earlier` before.
fn chat(fx: &mut Fx, id: &str, earlier: &[&str]) -> Agent {
    let mut a = fx
        .agent(Idle)
        .id(id)
        .since(NOW - 240.0)
        .activity(NOW - 240.0);
    a.earlier_sessions =
        (!earlier.is_empty()).then(|| earlier.iter().map(|s| (*s).to_string()).collect());
    a
}

mod work_started_before_a_clear {
    use super::*;

    #[test]
    fn a_shell_keeps_the_cleared_card_on_shell_running() {
        let (mut s, data, mut fx) = setup();
        let w = ws("shell").agents(vec![chat(&mut fx, "after", &["before"])]);
        assert_eq!(s.status_line(&data, Some(&w)), "Shell running 4m · 1 shell");
    }

    #[test]
    fn a_background_agent_keeps_the_cleared_card_on_helper_running() {
        let (mut s, data, mut fx) = setup();
        let w = ws("helper").agents(vec![chat(&mut fx, "after", &["before"])]);
        assert_eq!(
            s.status_line(&data, Some(&w)),
            "Helper running 4m · 1 helper"
        );
    }

    #[test]
    fn the_card_rests_once_the_work_has_ended() {
        let (mut s, data, mut fx) = setup();
        let ended = ws("helperDone").agents(vec![chat(&mut fx, "after", &["before"])]);
        assert_eq!(s.status_line(&data, Some(&ended)), "Idle 4m");
        let mut s = session("{}");
        let gone = ws("shell").agents(vec![chat(&mut fx, "after", &["before"])]);
        assert_eq!(s.status_line(&data, Some(&gone)), "Idle 4m", "shell ended");
    }

    #[test]
    fn a_shell_still_wins_over_a_background_agent() {
        let (mut s, data, mut fx) = setup();
        let w = ws("both").agents(vec![chat(&mut fx, "after", &["before"])]);
        assert_eq!(s.status_line(&data, Some(&w)), "Shell running 4m · 1 shell");
    }

    #[test]
    fn without_the_history_the_cleared_card_reads_idle() {
        let (mut s, data, mut fx) = setup();
        let w = ws("shell").agents(vec![chat(&mut fx, "after", &[])]);
        assert_eq!(s.status_line(&data, Some(&w)), "Idle 4m");
    }

    #[test]
    fn an_agent_cmux_sends_no_status_for_takes_no_shell() {
        let (mut s, data, mut fx) = setup();
        let stale = Agent {
            id: "before".to_string(),
            ..Agent::default()
        };
        let w = ws("shell").agents(vec![chat(&mut fx, "after", &["before"]), stale]);
        assert_eq!(s.status_line(&data, Some(&w)), "Shell running 4m · 1 shell");
    }

    #[test]
    fn a_session_running_again_in_another_chat_counts_for_that_chat_only() {
        let (mut s, _, mut fx) = setup();
        let cleared = chat(&mut fx, "after", &["before"]);
        let resumed = chat(&mut fx, "before", &[]);
        let w = ws("helper").agents(vec![cleared.clone(), resumed.clone()]);
        assert_eq!(s.own_run_count(Some(&w), &cleared), 0);
        assert_eq!(s.own_run_count(Some(&w), &resumed), 1);
        assert_eq!(s.live_run_count(Some(&w)), 1);
    }
}
