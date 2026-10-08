//! test/left-off-quiet.test.ts: a quiet agent (working, but silent for
//! QUIET_SECS) and the "You:" line on cards in the lanes you come back to.
//! The agents panel's head status is the agents sidebar's, left for its lane.

use cockpit_core::data::{Data, Workspace};
use cockpit_core::lane_entries::shows_left_off;
use cockpit_core::lanes::Lanes;
use cockpit_core::quiet::QUIET_SECS;
use cockpit_core::session::Session;
use cockpit_core::text::PromptMemory;
use cockpit_core::theme::Token;

use crate::support::*;

const NOW: f64 = 1_000_000.0;

fn working(fx: &mut Fx, silent_for: f64) -> Workspace {
    ws("w").agents(vec![
        fx.agent(Working)
            .since(NOW - 42.0 * 60.0)
            .activity(NOW - silent_for),
    ])
}

mod a_quiet_agent {
    use super::*;

    fn setup() -> (Session, Data, Fx) {
        (fresh(), frame(NOW, vec![], vec![]), Fx::default())
    }

    #[test]
    fn says_how_long_it_has_been_quiet_once_it_passes_quiet_secs() {
        let (mut s, data, mut fx) = setup();
        let w = working(&mut fx, 17.0 * 60.0);
        assert_eq!(s.status_line(&data, Some(&w)), "Working 42m · quiet 17m");
    }

    #[test]
    fn draws_a_hollow_blue_dot_with_no_halo_and_keeps_the_working_words_colour() {
        let (mut s, data, mut fx) = setup();
        let info = s.status_info(&data, Some(&working(&mut fx, QUIET_SECS)));
        assert_eq!(info.dot, None);
        assert_eq!(info.ring, Some(Token::Blue));
        assert_eq!(info.halo, Token::Clear);
        let busy = s.status_info(&data, Some(&working(&mut fx, 0.0)));
        assert_eq!(info.text, busy.text);
    }

    #[test]
    fn stays_plain_working_just_under_the_threshold() {
        let (mut s, data, mut fx) = setup();
        let w = working(&mut fx, QUIET_SECS - 1.0);
        assert_eq!(s.status_line(&data, Some(&w)), "Working 42m");
        assert_eq!(s.status_info(&data, Some(&w)).dot, Some(Token::Blue));
    }

    #[test]
    fn holds_off_while_a_helper_is_running_for_it() {
        let (mut s, data, mut fx) = setup();
        let mut w = working(&mut fx, 17.0 * 60.0);
        if let Some(Some(a)) = w.agents.as_mut().and_then(|l| l.first_mut()) {
            a.children = Some(vec![run("h1", Some(true), None)]);
        }
        assert_eq!(s.status_line(&data, Some(&w)), "Working 42m");
    }

    #[test]
    fn never_marks_an_agent_that_is_not_working_or_one_with_no_activity_time() {
        let (mut s, data, mut fx) = setup();
        let idle = ws("i").agents(vec![
            fx.agent(Idle).since(NOW - 3600.0).activity(NOW - 3600.0),
        ]);
        assert_eq!(s.status_line(&data, Some(&idle)), "Idle 1h");
        let bare = ws("b").agents(vec![fx.agent(Working).since(NOW - 3600.0)]);
        assert_eq!(s.status_line(&data, Some(&bare)), "Working 1h");
    }
}

mod where_you_left_off {
    use super::*;

    fn data() -> Data {
        frame(
            NOW,
            vec![
                group("g-main", "Main activity"),
                group("g-bg", "Background"),
                group("g-parked", "Parked"),
            ],
            vec![],
        )
    }

    #[test]
    fn shows_on_background_and_parked_cards_only() {
        let d = data();
        assert!(shows_left_off(
            &Lanes::default(),
            &d,
            Some(&ws("a").group("g-bg"))
        ));
        assert!(shows_left_off(
            &Lanes::default(),
            &d,
            Some(&ws("b").group("g-parked"))
        ));
        assert!(!shows_left_off(
            &Lanes::default(),
            &d,
            Some(&ws("c").group("g-main"))
        ));
        assert!(!shows_left_off(&Lanes::default(), &d, Some(&ws("d"))));
    }

    #[test]
    fn says_your_last_prompt_after_you() {
        let mut s = fresh();
        let w = ws("a").prompt("tighten slides 9 to 12");
        assert_eq!(s.left_off_text(Some(&w)), "You: tighten slides 9 to 12");
    }

    #[test]
    fn clips_a_long_prompt_to_one_lines_worth() {
        let mut s = fresh();
        let t = s.left_off_text(Some(&ws("a").prompt(&"word ".repeat(60))));
        assert_eq!(t.encode_utf16().count(), "You: ".len() + 90);
        assert!(t.ends_with('…'), "{t}");
    }

    #[test]
    fn is_empty_with_no_prompt_or_a_harness_turn_before_any_prompt() {
        let mut s = fresh();
        assert_eq!(s.left_off_text(Some(&ws("none"))), "");
        let hand_back = "<task-notification>the helper finished";
        let fresh_ws = ws("fresh").prompt(hand_back);
        assert_eq!(PromptMemory::default().prompt_text(Some(&fresh_ws)), "");
        assert_eq!(s.left_off_text(Some(&fresh_ws)), "");
    }

    #[test]
    fn keeps_the_last_real_prompt_through_a_harness_turn_as_the_asked_line_does() {
        let mut s = fresh();
        let kept = ws("kept").prompt("refactor the bridge");
        assert_eq!(s.left_off_text(Some(&kept)), "You: refactor the bridge");
        let hand_back = ws("kept").prompt("[Subagent hand-back] done");
        assert_eq!(
            s.left_off_text(Some(&hand_back)),
            "You: refactor the bridge"
        );
    }
}
