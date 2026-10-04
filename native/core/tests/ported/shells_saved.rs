//! test/shells-saved.test.ts: a card whose chat is idle on a background
//! shell still running reads "Waiting 4m · 1 shell" in working blue.

use cockpit_core::data::{Agent, Data};
use cockpit_core::session::Session;
use cockpit_core::shells::live_shell_count;
use cockpit_core::theme::Token;
use cockpit_core::ui::Urgency;

use crate::support::*;

const NOW: f64 = 1_000_000.0;

const STATE: &str = r#"{
    "shells": {
        "one": [{"id": "b1", "session": "chat", "startedEpoch": 100}],
        "two": [{"id": "b1", "session": "chat", "startedEpoch": 100}, {"id": "b2", "session": "chat", "startedEpoch": 100}],
        "other": [{"id": "b1", "session": "someone-else", "startedEpoch": 100}],
        "quiet": [{"id": "b1", "session": "chat", "startedEpoch": 100}]
    },
    "moves": {
        "quiet": {"text": "the rounds take about 20 minutes, and I report what they show.", "epoch": 1000, "session": "chat", "idle": true},
        "quietDone": {"text": "CI is running.", "epoch": 1000, "session": "chat", "idle": true}
    }
}"#;

fn setup() -> (Session, Data, Fx) {
    (session(STATE), frame(NOW, vec![], vec![]), Fx::default())
}

fn idle(fx: &mut Fx) -> Agent {
    fx.agent(Idle)
        .id("chat")
        .since(NOW - 240.0)
        .activity(NOW - 240.0)
}

mod background_shells_on_the_card {
    use super::*;

    #[test]
    fn counts_the_saved_shells_of_the_chat_that_started_them() {
        let (s, _, mut fx) = setup();
        let a = idle(&mut fx);
        let one = ws("one").agents(vec![a.clone()]);
        let two = ws("two").agents(vec![a.clone()]);
        assert_eq!(live_shell_count(&s.saved, Some(&one), Some(&a)), 1);
        assert_eq!(live_shell_count(&s.saved, Some(&two), Some(&a)), 2);
    }

    #[test]
    fn counts_none_for_another_chat_an_ended_one_or_none() {
        let (s, _, mut fx) = setup();
        let a = idle(&mut fx);
        let other = ws("other").agents(vec![a.clone()]);
        assert_eq!(live_shell_count(&s.saved, Some(&other), Some(&a)), 0);
        let ended = fx.agent(Ended).id("chat");
        let one = ws("one").agents(vec![ended.clone()]);
        assert_eq!(live_shell_count(&s.saved, Some(&one), Some(&ended)), 0);
        let none = ws("none").agents(vec![a.clone()]);
        assert_eq!(live_shell_count(&s.saved, Some(&none), Some(&a)), 0);
        assert_eq!(live_shell_count(&s.saved, Some(&ws("one")), None), 0);
        assert_eq!(live_shell_count(&s.saved, None, Some(&a)), 0);
    }

    #[test]
    fn does_not_turn_another_chats_card_to_waiting() {
        let (mut s, data, mut fx) = setup();
        let w = ws("other").agents(vec![idle(&mut fx)]);
        assert!(s.status_line(&data, Some(&w)).starts_with("Idle"));
    }

    #[test]
    fn reads_waiting_in_working_blue_with_the_idle_age_and_the_shell_count() {
        let (mut s, data, mut fx) = setup();
        let idle_line = s.status_line(&data, Some(&ws("none").agents(vec![idle(&mut fx)])));
        assert_eq!(idle_line, "Idle 4m");
        let w = ws("one").agents(vec![idle(&mut fx)]);
        let waiting = idle_line.replace("Idle", "Waiting");
        assert_eq!(
            s.status_line(&data, Some(&w)),
            format!("{waiting} · 1 shell")
        );
        let two = ws("two").agents(vec![idle(&mut fx)]);
        assert_eq!(
            s.status_line(&data, Some(&two)),
            format!("{waiting} · 2 shells")
        );
        let info = s.status_info(&data, Some(&w));
        assert_eq!(info.dot, Some(Token::Blue));
        assert_eq!(info.urgency, Urgency::Working);
    }

    #[test]
    fn stays_ready_while_its_finished_turn_is_unread_since_the_shell_may_never_end() {
        let (mut s, data, mut fx) = setup();
        let w = ws("one").unread(2.0).agents(vec![idle(&mut fx)]);
        assert!(s.is_ready(&data, Some(&w)));
        assert!(s.status_line(&data, Some(&w)).starts_with("Finished"));
    }

    #[test]
    fn stays_waiting_not_ready_on_a_nothing_for_you_turn_while_its_shell_runs() {
        let (mut s, data, mut fx) = setup();
        let a = fx
            .agent(Idle)
            .id("chat")
            .kind("claude")
            .since(1000.0)
            .activity(1000.0);
        let w = ws("quiet").unread(1.0).latest_at(950.0).agents(vec![a]);
        assert!(!s.is_ready(&data, Some(&w)));
        let line = s.status_line(&data, Some(&w));
        assert!(
            line.starts_with("Waiting ") && line.ends_with(" · 1 shell"),
            "{line}"
        );
    }

    #[test]
    fn is_ready_on_a_nothing_for_you_turn_once_no_shell_runs_so_a_late_failure_still_shows() {
        let (mut s, data, mut fx) = setup();
        let a = fx
            .agent(Idle)
            .id("chat")
            .kind("claude")
            .since(1000.0)
            .activity(1000.0);
        let w = ws("quietDone").unread(1.0).latest_at(950.0).agents(vec![a]);
        assert!(s.is_ready(&data, Some(&w)));
    }

    #[test]
    fn leaves_a_working_chat_as_working() {
        let (mut s, data, mut fx) = setup();
        let w = ws("one").agents(vec![fx.agent(Working).id("chat").since(NOW - 60.0)]);
        assert!(s.status_line(&data, Some(&w)).starts_with("Working"));
    }
}
