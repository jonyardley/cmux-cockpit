//! test/asking-saved.test.ts: asking or your turn (issue #81), from the
//! saved asks the notification hook writes. The agents panel cases test
//! the agents sidebar, left for its lane.

use cockpit_core::data::{Agent, Data};
use cockpit_core::needs::ask_reason;
use cockpit_core::saved::HOOK_SLACK;
use cockpit_core::session::Session;
use cockpit_core::status::StatusStyle;
use cockpit_core::theme::Token;
use cockpit_core::ui::Urgency;

use crate::support::*;

const STATE: &str = r#"{"asking": {
    "wA": {"reason": "allow git push?", "epoch": 1000, "session": "s1"},
    "sel": {"reason": "Which layout?", "epoch": 1000},
    "owned": {"reason": "allow npm publish?", "epoch": 1500, "session": "sessA"}
}}"#;

fn setup() -> (Session, Data, Fx) {
    (session(STATE), frame(1060.0, vec![], vec![]), Fx::default())
}

/// An agent that went needs_input at `since`, its turn having worked until then.
fn waiting(fx: &mut Fx, since: f64) -> Agent {
    fx.agent(NeedsInput).since(since).activity(since)
}

mod ask_reason {
    use super::*;

    #[test]
    fn is_the_saved_reason_while_the_ask_is_at_least_as_new_as_the_spell() {
        let (s, _, mut fx) = setup();
        let w = ws("wA");
        let reason = |a: &Agent| ask_reason(&s.saved, Some(a), Some(&w));
        let want = Some("allow git push?".to_string());
        assert_eq!(reason(&waiting(&mut fx, 1000.0)), want);
        assert_eq!(
            reason(&waiting(&mut fx, 990.0)),
            want,
            "an ask heard after the spell began"
        );
        assert_eq!(
            reason(&waiting(&mut fx, 1000.0 + HOOK_SLACK)),
            want,
            "within the slack"
        );
    }

    #[test]
    fn is_null_once_the_spell_began_after_the_ask_the_agent_worked_again_and_finished() {
        let (s, _, mut fx) = setup();
        let a = waiting(&mut fx, 1001.0 + HOOK_SLACK);
        assert_eq!(ask_reason(&s.saved, Some(&a), Some(&ws("wA"))), None);
    }

    #[test]
    fn is_null_without_a_saved_ask_a_start_time_a_needs_input_or_an_agent() {
        let (s, _, mut fx) = setup();
        let w = ws("wA");
        assert_eq!(
            ask_reason(
                &s.saved,
                Some(&waiting(&mut fx, 1000.0)),
                Some(&ws("other"))
            ),
            None
        );
        assert_eq!(
            ask_reason(&s.saved, Some(&fx.agent(NeedsInput)), Some(&w)),
            None
        );
        assert_eq!(
            ask_reason(&s.saved, Some(&fx.agent(Working).since(1000.0)), Some(&w)),
            None
        );
        assert_eq!(ask_reason(&s.saved, None, Some(&w)), None);
        assert_eq!(
            ask_reason(&s.saved, Some(&waiting(&mut fx, 1000.0)), None),
            None
        );
    }

    #[test]
    fn gives_the_ask_only_to_the_agent_whose_id_is_the_asking_session_when_one_has_it() {
        let (s, _, mut fx) = setup();
        let asker = fx.agent(NeedsInput).id("sessA").since(1500.0);
        let finished = fx.agent(NeedsInput).id("sessB").since(1000.0);
        let w = ws("owned").agents(vec![asker.clone(), finished.clone()]);
        assert_eq!(
            ask_reason(&s.saved, Some(&asker), Some(&w)),
            Some("allow npm publish?".into())
        );
        assert_eq!(
            ask_reason(&s.saved, Some(&finished), Some(&w)),
            None,
            "another agent's turn end never borrows the reason"
        );
        // No agent carries the session as its id: the ask is the workspace's.
        let loose = fx.agent(NeedsInput).id("other").since(1500.0);
        let lw = ws("owned").agents(vec![loose.clone()]);
        assert_eq!(
            ask_reason(&s.saved, Some(&loose), Some(&lw)),
            Some("allow npm publish?".into())
        );
    }

    #[test]
    fn reads_a_fresh_ask_as_an_ask_even_after_a_long_quiet_spell_and_an_older_one_as_the_nudge() {
        let (mut s, _, mut fx) = setup();
        let quiet = fx
            .agent(NeedsInput)
            .kind("claude")
            .activity(900.0)
            .since(1000.0);
        let w = ws("wA").agents(vec![quiet.clone()]);
        assert!(!cockpit_core::needs::is_idle_nudge(
            &s.saved,
            &quiet,
            Some(&w)
        ));
        let shown = s.agents_of(Some(&w));
        assert_eq!(
            ask_reason(&s.saved, shown.first(), Some(&w)),
            Some("allow git push?".into())
        );
    }

    #[test]
    fn never_reads_a_nudge_or_a_dismissal_as_an_ask_once_the_agent_is_as_the_sidebars_show_it() {
        let (mut s, _, mut fx) = setup();
        let nudge = fx
            .agent(NeedsInput)
            .kind("claude")
            .activity(1000.0)
            .since(1100.0);
        let w = ws("wA").agents(vec![nudge]);
        let shown = s.agents_of(Some(&w));
        assert_eq!(ask_reason(&s.saved, shown.first(), Some(&w)), None);
        let d = ws("wA").agents(vec![waiting(&mut fx, 1000.0)]);
        s.dismiss_needs(Some(&d));
        let shown = s.agents_of(Some(&d));
        assert_eq!(ask_reason(&s.saved, shown.first(), Some(&d)), None);
        s.restore_needs(Some(&d));
        let shown = s.agents_of(Some(&d));
        assert_eq!(
            ask_reason(&s.saved, shown.first(), Some(&d)),
            Some("allow git push?".into())
        );
    }
}

mod cockpit {
    use super::*;

    #[test]
    fn shows_an_asking_card_amber_with_its_reason_and_a_finished_turn_clay() {
        let (mut s, mut data, mut fx) = setup();
        let asking = ws("wA").agents(vec![waiting(&mut fx, 1000.0)]);
        assert_eq!(s.ask_of(Some(&asking)), Some("allow git push?".into()));
        let amber = StatusStyle {
            label: "Asking",
            dot: Some(Token::Amber),
            halo: Token::AmberHalo,
            text: Token::AmberText,
            ring: None,
            urgency: Urgency::Asking,
        };
        assert_eq!(s.status_info(&data, Some(&asking)), amber);
        assert_eq!(s.status_line(&data, Some(&asking)), "Asking 1m");
        assert_eq!(s.needs_detail(Some(&asking)), "allow git push?");
        assert_eq!(s.needs_row_edge(Some(&asking)), Token::AmberRowEdge);
        assert_eq!(
            s.needs_line(&data, Some(&asking)),
            "Asking: allow git push?"
        );
        assert_eq!(s.needs_ink(Some(&asking)), Token::AmberText);
        assert_eq!(s.placeholder_text(Some(&asking)), "is asking");

        let turn = ws("wA")
            .agents(vec![waiting(&mut fx, 1100.0)])
            .message("Pushed it.");
        data.epoch = Some(1160.0);
        assert_eq!(s.ask_of(Some(&turn)), None);
        assert_eq!(s.status_info(&data, Some(&turn)).label, "Your turn");
        assert_eq!(s.status_info(&data, Some(&turn)).dot, Some(Token::Clay));
        assert_eq!(s.needs_detail(Some(&turn)), "Pushed it.");
        assert_eq!(s.needs_row_edge(Some(&turn)), Token::NeedsRowEdge);
        assert_eq!(s.needs_line(&data, Some(&turn)), "Your turn: Pushed it.");
        assert_eq!(s.needs_ink(Some(&turn)), Token::ClayText);
        assert_eq!(s.placeholder_text(Some(&turn)), "your turn");
        let bare = ws("x").agents(vec![waiting(&mut fx, 1100.0)]);
        assert_eq!(s.needs_detail(Some(&bare)), "Waiting for your reply");
    }

    #[test]
    fn lists_asking_and_your_turn_workspaces_alike_in_needs_you() {
        let (mut s, _, mut fx) = setup();
        let data = frame(
            1060.0,
            vec![],
            vec![
                ws("wA").agents(vec![waiting(&mut fx, 1000.0)]),
                ws("other").agents(vec![waiting(&mut fx, 1010.0)]),
            ],
        );
        let list: Vec<&str> = s.needs_list(&data).iter().map(|w| w.id.as_str()).collect();
        assert_eq!(list, ["wA", "other"]);
    }
}
