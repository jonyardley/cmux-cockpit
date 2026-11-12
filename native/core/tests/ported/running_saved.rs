//! A card whose chat is idle on a background shell still running reads
//! "Running 4m · 1 shell" in working blue (#359: the status reads the
//! `background` record; the old `shells` map retired in #361 and is never
//! read).

use cockpit_core::data::{Agent, Data};
use cockpit_core::session::Session;
use cockpit_core::theme::Token;
use cockpit_core::ui::Urgency;

use crate::support::*;

const NOW: f64 = 1_000_000.0;

const STATE: &str = r#"{
    "background": {
        "one": [{"id": "b1", "type": "shell", "status": "running", "description": "build", "session": "chat", "startedEpoch": 999760, "seenEpoch": 999900}],
        "two": [{"id": "b1", "type": "shell", "status": "running", "description": "build", "session": "chat", "startedEpoch": 999760, "seenEpoch": 999900},
                {"id": "b2", "type": "monitor", "status": "running", "description": "watch", "session": "chat", "startedEpoch": 999800, "seenEpoch": 999900}],
        "other": [{"id": "b1", "type": "shell", "status": "running", "description": "build", "session": "someone-else", "startedEpoch": 999760, "seenEpoch": 999900}],
        "quiet": [{"id": "b1", "type": "shell", "status": "running", "description": "build", "session": "chat", "startedEpoch": 999760, "seenEpoch": 999900}]
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
    fn does_not_turn_another_chats_card_to_running() {
        let (mut s, data, mut fx) = setup();
        let w = ws("other").agents(vec![idle(&mut fx)]);
        assert!(s.status_line(&data, Some(&w)).starts_with("Idle"));
    }

    #[test]
    fn reads_running_in_working_blue_from_the_earliest_start_with_the_shell_count() {
        let (mut s, data, mut fx) = setup();
        let idle_line = s.status_line(&data, Some(&ws("none").agents(vec![idle(&mut fx)])));
        assert_eq!(idle_line, "Idle 4m");
        let w = ws("one").agents(vec![idle(&mut fx)]);
        let running = idle_line.replace("Idle", "Running");
        assert_eq!(
            s.status_line(&data, Some(&w)),
            format!("{running} · 1 shell")
        );
        let two = ws("two").agents(vec![idle(&mut fx)]);
        assert_eq!(
            s.status_line(&data, Some(&two)),
            format!("{running} · 2 shells")
        );
        let info = s.status_info(&data, Some(&w));
        assert_eq!(info.dot, Some(Token::Blue));
        assert_eq!(info.urgency, Urgency::Working);
    }

    #[test]
    fn falls_back_to_the_word_and_age_alone_with_the_counts_dropped_whole() {
        let (mut s, data, mut fx) = setup();
        let w = ws("one").agents(vec![idle(&mut fx)]);
        let (full, short) = s.status_forms(&data, Some(&w));
        assert_eq!(full, format!("{short} · 1 shell"));
        assert_eq!(short, "Running 4m");
        let none = ws("none").agents(vec![idle(&mut fx)]);
        assert_eq!(s.status_forms(&data, Some(&none)).1, "", "no tail to drop");
    }

    #[test]
    fn stays_ready_while_its_finished_turn_is_unread_since_the_shell_may_never_end() {
        let (mut s, data, mut fx) = setup();
        let w = ws("one").unread(2.0).agents(vec![idle(&mut fx)]);
        assert!(s.is_ready(&data, Some(&w)));
        assert!(s.status_line(&data, Some(&w)).starts_with("Finished"));
    }

    #[test]
    fn stays_running_not_ready_on_a_nothing_for_you_turn_while_its_shell_runs() {
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
            line.starts_with("Running ") && line.ends_with(" · 1 shell"),
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
    fn reads_only_the_background_record_never_the_old_shell_map() {
        let (mut s, data, mut fx) = setup();
        let mut old = session(
            r#"{"shells": {"one": [{"id": "b1", "session": "chat", "startedEpoch": 100}]}}"#,
        );
        let w = ws("one").agents(vec![idle(&mut fx)]);
        assert_eq!(old.status_line(&data, Some(&w)), "Idle 4m");
        assert!(s.status_line(&data, Some(&w)).starts_with("Running"));
    }

    #[test]
    fn leaves_a_working_chat_as_working() {
        let (mut s, data, mut fx) = setup();
        let w = ws("one").agents(vec![fx.agent(Working).id("chat").since(NOW - 60.0)]);
        assert!(s.status_line(&data, Some(&w)).starts_with("Working"));
    }
}
