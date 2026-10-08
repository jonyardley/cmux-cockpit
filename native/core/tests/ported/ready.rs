//! test/ready.test.ts: the Ready state on cockpit cards (issue #53), its
//! PR words, with the chips row it keeps (chips.ts).

use cockpit_core::data::{Agent, AgentStatus, Data, PrStatus, Workspace};
use cockpit_core::prs::pr_summary;
use cockpit_core::session::Session;
use cockpit_core::status::{Status, compact_pr_text};
use cockpit_core::theme::Token;

use crate::support::*;

const NOW: f64 = 1_000_100.0;

/// The saved PRs the TypeScript seeds __STATE__ with, by workspace id.
const STATE: &str = r#"{"prs": {
    "green": {"url": "https://github.com/o/r/pull/45", "status": "open", "branch": "feat", "number": 45, "mergeable": true, "checks": [{"name": "build", "state": "pass"}]},
    "failing": {"url": "https://github.com/o/r/pull/45", "status": "open", "branch": "feat", "number": 46, "checks": [{"name": "build", "state": "fail"}]},
    "running": {"url": "https://github.com/o/r/pull/45", "status": "open", "branch": "feat", "number": 47, "checks": [{"name": "build", "state": "pending"}]},
    "draft": {"url": "https://github.com/o/r/pull/45", "status": "open", "branch": "feat", "number": 48, "draft": true, "checks": [{"name": "build", "state": "pass"}]},
    "open": {"url": "https://github.com/o/r/pull/45", "status": "open", "branch": "feat", "number": 49}
}}"#;

fn setup() -> (Session, Data, Fx) {
    (session(STATE), frame(NOW, vec![], vec![]), Fx::default())
}

/// An agent that worked until `ago` seconds back, then settled on `st`.
fn finished(fx: &mut Fx, st: AgentStatus, ago: f64) -> Agent {
    fx.agent(st).activity(NOW - ago).since(NOW - ago)
}

/// A finished workspace with unread output.
fn ready_ws(fx: &mut Fx, id: &str) -> Workspace {
    let a = finished(fx, Idle, 360.0);
    ws(id).unread(2.0).agents(vec![a])
}

/// A real ask, from a Claude session a moment ago.
fn ask(fx: &mut Fx) -> Agent {
    fx.agent(NeedsInput)
        .kind("claude")
        .activity(NOW - 3.0)
        .since(NOW - 2.0)
}

mod is_ready {
    use super::*;

    #[test]
    fn is_ready_when_an_agent_went_idle_or_ended_after_working_and_the_output_is_unread() {
        let (mut s, data, mut fx) = setup();
        assert!(s.is_ready(&data, Some(&ready_ws(&mut fx, "w"))));
        let ended = ready_ws(&mut fx, "e").agents(vec![finished(&mut fx, Ended, 360.0)]);
        assert!(s.is_ready(&data, Some(&ended)));
    }

    #[test]
    fn is_not_ready_once_the_output_is_read() {
        let (mut s, data, mut fx) = setup();
        assert!(!s.is_ready(&data, Some(&ready_ws(&mut fx, "w").unread(0.0))));
        let unread_none = ws("w").agents(vec![finished(&mut fx, Idle, 360.0)]);
        assert!(!s.is_ready(&data, Some(&unread_none)));
    }

    #[test]
    fn clears_while_the_workspace_is_open() {
        let (mut s, data, mut fx) = setup();
        assert!(!s.is_ready(&data, Some(&ready_ws(&mut fx, "w").selected())));
    }

    #[test]
    fn clears_the_moment_jon_taps_the_card_before_cmux_publishes_the_selection() {
        let (mut s, mut data, mut fx) = setup();
        let w = ready_ws(&mut fx, "tapped");
        s.select_workspace(&data, Some("tapped"));
        assert!(!s.is_ready(&data, Some(&w)));
        assert!(s.is_ready(&data, Some(&ready_ws(&mut fx, "other"))));
        // Once cmux agrees, the workspace's own flag takes over again.
        data.selected_id = Some("tapped".into());
        let selected = ready_ws(&mut fx, "tapped").selected();
        assert!(!s.is_ready(&data, Some(&selected)));
        assert!(s.is_ready(&data, Some(&ready_ws(&mut fx, "tapped"))));
    }

    #[test]
    fn clears_the_moment_the_sidebar_selects_it_through_cmuxs_sdk() {
        let (mut s, mut data, mut fx) = setup();
        let w = ready_ws(&mut fx, "clicked");
        s.mark_selected(&data, "clicked");
        assert!(!s.is_ready(&data, Some(&w)));
        assert!(s.is_ready(&data, Some(&ready_ws(&mut fx, "other"))));
        assert!(s.take_outbox().is_empty(), "no cmux call of its own");
        // A select cmux never publishes lapses, and the card is Ready again.
        data.epoch = Some(NOW + 5.0);
        assert!(s.is_ready(&data, Some(&w)));
    }

    #[test]
    fn reports_an_ended_agent_that_worked_beside_a_fresh_idle_session_that_never_did() {
        let (mut s, data, mut fx) = setup();
        let fresh = fx.agent(Idle).since(NOW - 30.0);
        let w = ready_ws(&mut fx, "pair").agents(vec![finished(&mut fx, Ended, 600.0), fresh]);
        assert!(s.is_ready(&data, Some(&w)));
        assert_eq!(s.status_line(&data, Some(&w)), "Finished 10m");
    }

    #[test]
    fn needs_the_agent_to_have_worked_no_recorded_activity_is_not_a_finished_run() {
        let (mut s, data, mut fx) = setup();
        let w = ws("w")
            .unread(1.0)
            .agents(vec![fx.agent(Idle).since(NOW - 60.0)]);
        assert!(!s.is_ready(&data, Some(&w)));
    }

    #[test]
    fn is_never_ready_while_an_agent_works_or_really_asks() {
        let (mut s, data, mut fx) = setup();
        let working = ready_ws(&mut fx, "w").agents(vec![finished(&mut fx, Working, 360.0)]);
        assert!(!s.is_ready(&data, Some(&working)));
        let both = ready_ws(&mut fx, "w").agents(vec![
            finished(&mut fx, Idle, 360.0),
            finished(&mut fx, Working, 5.0),
        ]);
        assert!(!s.is_ready(&data, Some(&both)));
        let asking = ready_ws(&mut fx, "w").agents(vec![ask(&mut fx)]);
        assert!(!s.is_ready(&data, Some(&asking)));
    }

    #[test]
    fn stays_off_for_a_real_ask_jon_dismissed_the_agent_stopped_to_ask_it_did_not_finish() {
        let (mut s, data, mut fx) = setup();
        let w = ready_ws(&mut fx, "dismissed").agents(vec![ask(&mut fx)]);
        s.dismiss_needs(Some(&w));
        assert_eq!(s.status_of(Some(&w)), Status::Idle);
        assert!(!s.is_ready(&data, Some(&w)));
        s.restore_needs(Some(&w));
    }

    #[test]
    fn counts_claudes_idle_nudge_as_finished() {
        let (mut s, data, mut fx) = setup();
        let nudge = fx
            .agent(NeedsInput)
            .kind("claude")
            .activity(NOW - 400.0)
            .since(NOW - 340.0);
        let w = ready_ws(&mut fx, "nudge").agents(vec![nudge]);
        assert!(!s.has_real_ask(Some(&w)));
        assert!(s.is_ready(&data, Some(&w)));
        // The idle spell began when the turn ended, not when the nudge landed.
        assert_eq!(s.status_line(&data, Some(&w)), "Finished 6m");
    }

    #[test]
    fn is_false_with_no_workspace_or_no_agent() {
        let (mut s, data, _) = setup();
        assert!(!s.is_ready(&data, None));
        assert!(!s.is_ready(&data, Some(&ws("w").unread(3.0))));
    }
}

mod a_ready_card {
    use super::*;

    #[test]
    fn says_when_it_finished_in_the_finished_green() {
        let (mut s, data, mut fx) = setup();
        let w = ready_ws(&mut fx, "w");
        assert_eq!(s.status_line(&data, Some(&w)), "Finished 6m");
        let info = s.status_info(&data, Some(&w));
        assert_eq!(info.label, "Finished");
        assert_eq!(info.dot, Some(Token::Green));
        assert_eq!(info.text, Token::GreenText);
        assert_eq!(info.halo, Token::Clear);
    }

    #[test]
    fn falls_back_to_the_last_activity_when_nothing_says_when_it_finished() {
        let (mut s, data, mut fx) = setup();
        let w = ws("w")
            .unread(1.0)
            .agents(vec![fx.agent(Idle).activity(NOW - 180.0)]);
        assert_eq!(s.status_line(&data, Some(&w)), "Finished 3m");
    }

    #[test]
    fn counts_from_the_finish_not_a_later_last_activity_as_the_agents_panel_does_issue_98() {
        let (mut s, data, mut fx) = setup();
        let a = fx.agent(Idle).since(NOW - 360.0).activity(NOW - 180.0);
        let w = ready_ws(&mut fx, "w").agents(vec![a.clone()]);
        assert_eq!(s.status_line(&data, Some(&w)), "Finished 6m");
        let read = ready_ws(&mut fx, "w").unread(0.0).agents(vec![a]);
        assert_eq!(s.status_line(&data, Some(&read)), "Idle 6m");
    }

    #[test]
    fn dates_an_ended_agent_by_its_work_not_by_when_its_terminal_closed() {
        let (mut s, data, mut fx) = setup();
        let closed = fx.agent(Ended).since(NOW - 5.0).activity(NOW - 10_800.0);
        let w = ready_ws(&mut fx, "w").agents(vec![closed]);
        assert_eq!(s.status_line(&data, Some(&w)), "Finished 3h");
    }

    #[test]
    fn reports_the_agent_the_rest_of_the_card_reports_so_its_two_ages_agree() {
        let (mut s, data, mut fx) = setup();
        let a = fx.agent(Idle).since(NOW - 900.0).activity(NOW - 60.0);
        let b = fx.agent(Idle).since(NOW - 300.0).activity(NOW - 240.0);
        let w = ready_ws(&mut fx, "w").agents(vec![a.clone(), b.clone()]);
        assert_eq!(s.ready_agent(&data, Some(&w)), Some(a.clone()));
        assert_eq!(s.status_line(&data, Some(&w)), "Finished 15m");
        assert_eq!(s.age_of(&data, Some(&w)), "15m");
        // Once read, the card still reports the same agent and age.
        let read = ready_ws(&mut fx, "w").unread(0.0).agents(vec![a, b]);
        assert_eq!(s.status_line(&data, Some(&read)), "Idle 15m");
        assert_eq!(s.ready_agent(&data, Some(&ws("none"))), None);
    }

    #[test]
    fn keeps_the_plain_labels_once_read() {
        let (mut s, data, mut fx) = setup();
        let read = ready_ws(&mut fx, "w").unread(0.0);
        assert_eq!(s.status_line(&data, Some(&read)), "Idle 6m");
        let ended = ready_ws(&mut fx, "w")
            .unread(0.0)
            .agents(vec![finished(&mut fx, Ended, 360.0)]);
        assert_eq!(s.status_line(&data, Some(&ended)), "Finished 6m");
    }

    #[test]
    fn hides_the_unread_badge_behind_the_pill_and_shows_it_otherwise() {
        let (mut s, data, mut fx) = setup();
        assert_eq!(s.badge_count(&data, Some(&ready_ws(&mut fx, "w"))), 0.0);
        let busy = ws("w")
            .unread(4.0)
            .agents(vec![finished(&mut fx, Working, 360.0)]);
        assert_eq!(s.badge_count(&data, Some(&busy)), 4.0);
        assert_eq!(s.badge_count(&data, None), 0.0);
    }
}

mod a_ready_cards_pr_words_issue_79 {
    use super::*;

    fn with_pr(fx: &mut Fx, id: &str) -> Workspace {
        ready_ws(fx, id).branch("feat")
    }

    /// The compact card's PR words for `w`.
    fn text(s: &Session, w: &Workspace) -> String {
        compact_pr_text(
            pr_summary(&s.saved, Some(w))
                .as_ref()
                .map(|p| p.text.as_str()),
        )
    }

    #[test]
    fn leaves_the_prs_words_out_of_the_status_line_since_the_chips_row_carries_it() {
        let (mut s, data, mut fx) = setup();
        // A PR GitHub would merge changes the status itself (issue #299),
        // never the words after it.
        let green = with_pr(&mut fx, "green");
        assert_eq!(s.status_line(&data, Some(&green)), "Ready to merge 6m");
        let failing = with_pr(&mut fx, "failing");
        assert_eq!(s.status_line(&data, Some(&failing)), "Finished 6m");
    }

    #[test]
    fn keeps_the_pr_on_a_compact_card_in_the_chips_own_words() {
        let (s, _, mut fx) = setup();
        assert_eq!(text(&s, &with_pr(&mut fx, "green")), "· #45 · ready");
        assert_eq!(text(&s, &with_pr(&mut fx, "failing")), "· #46 · 1 failing");
        assert_eq!(text(&s, &with_pr(&mut fx, "running")), "· #47 · running");
        assert_eq!(text(&s, &with_pr(&mut fx, "draft")), "· #48 · draft");
        assert_eq!(text(&s, &with_pr(&mut fx, "open")), "· #49");
        let merged = ready_ws(&mut fx, "m").pr(pr(50.0, Some(PrStatus::Merged)));
        assert_eq!(text(&s, &merged), "· #50 · merged");
    }

    #[test]
    fn is_empty_without_a_pr() {
        let (s, _, mut fx) = setup();
        assert_eq!(text(&s, &ready_ws(&mut fx, "none")), "");
        assert_eq!(compact_pr_text(None), "");
        assert_eq!(compact_pr_text(Some("")), "");
    }
}

mod a_ready_cards_chips_row {
    use super::*;

    #[test]
    fn has_no_row_of_its_own_with_no_chip_a_ready_card_draws_none() {
        let (mut s, _, mut fx) = setup();
        let w = ready_ws(&mut fx, "w").group("g-main");
        let data = frame(NOW, vec![group("g-main", "Main activity")], vec![w.clone()]);
        assert!(s.is_ready(&data, Some(&w)));
        assert!(s.chips_for(Some(&w), true).is_empty());
    }

    #[test]
    fn still_counts_a_chip_as_a_chips_row() {
        let (mut s, _, _) = setup();
        let w = ws("b").branch("feat");
        assert!(!s.chips_for(Some(&w), true).is_empty());
        assert!(s.chips_for(Some(&w), false).is_empty());
    }
}
