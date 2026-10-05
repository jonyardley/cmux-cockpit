//! test/ready.test.ts: the Ready state on cockpit cards (issue #53), its
//! PR words, and To review, with the chips row it keeps (chips.ts).

use cockpit_core::data::{Agent, AgentStatus, Data, PrStatus, Workspace, WorkspaceGroup};
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
    fn leaves_the_pr_out_of_the_status_line_since_the_chips_row_carries_it() {
        let (mut s, data, mut fx) = setup();
        let green = with_pr(&mut fx, "green");
        assert_eq!(s.status_line(&data, Some(&green)), "Finished 6m");
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

mod to_review {
    use super::*;

    fn lanes() -> Vec<WorkspaceGroup> {
        vec![
            group("g-review", "For review"),
            group("g-main", "Main activity"),
        ]
    }

    #[test]
    fn offers_to_review_on_a_ready_card_outside_for_review_and_files_it_there() {
        let (mut s, _, mut fx) = setup();
        let w = ready_ws(&mut fx, "w").group("g-main");
        let data = frame(NOW, lanes(), vec![w.clone()]);
        assert!(s.can_file_for_review(&data, Some(&w)));
        assert!(s.has_chips_row(&data, Some(&w), true));
        // The action alone keeps the row, with no chip at all.
        let chips = s.chips_for(Some(&w), true);
        assert!(chips.is_empty());
        assert!(s.shows_chips_row(&data, &chips, Some(&w)));
        s.file_for_review(&data, Some(&w));
        assert_eq!(
            calls(&s).last(),
            Some(&call(
                "workspace.group.add",
                &[("group_id", "g-review"), ("workspace_id", "w")]
            ))
        );
        // The move shows at once, so the action goes with it.
        assert!(!s.can_file_for_review(&data, Some(&w)));
    }

    #[test]
    fn offers_to_review_in_green_on_a_card_whose_pr_is_ready_to_merge_ready_or_not() {
        let (mut s, _, mut fx) = setup();
        let read = ws("green")
            .group("g-main")
            .branch("feat")
            .agents(vec![fx.agent(Working)]);
        let data = frame(NOW, lanes(), vec![read.clone()]);
        assert!(
            !s.is_ready(&data, Some(&read)),
            "its agent is still working"
        );
        assert!(
            s.can_file_for_review(&data, Some(&read)),
            "the ready PR is reason enough"
        );
        assert!(s.review_is_green(Some(&read)));
        assert!(
            !s.review_is_green(Some(&ready_ws(&mut fx, "w"))),
            "a Ready card with no PR keeps the white chip"
        );
        for id in ["failing", "running", "draft", "open"] {
            let w = ws(id).group("g-main").branch("feat");
            assert!(!s.review_is_green(Some(&w)), "{id}");
            assert!(!s.can_file_for_review(&data, Some(&w)), "{id}");
        }
    }

    #[test]
    fn is_not_offered_in_for_review_off_a_ready_card_or_with_no_workspace() {
        let (mut s, _, mut fx) = setup();
        let in_review = ready_ws(&mut fx, "r").group("g-review");
        let read = ready_ws(&mut fx, "x").unread(0.0);
        let data = frame(NOW, lanes(), vec![in_review.clone(), read.clone()]);
        assert!(!s.can_file_for_review(&data, Some(&in_review)));
        assert!(!s.can_file_for_review(&data, Some(&read)));
        assert!(!s.has_chips_row(&data, Some(&read), true));
        assert!(!s.can_file_for_review(&data, None));
    }

    #[test]
    fn is_not_offered_on_a_real_workspace_anchoring_a_group_which_cannot_leave_it() {
        let (mut s, _, mut fx) = setup();
        let mut groups = lanes();
        groups.push(group("g-proj", "Some project").anchor("real"));
        let real = ready_ws(&mut fx, "real")
            .title("Status update")
            .group("g-proj");
        let data = frame(NOW, groups, vec![real.clone()]);
        assert!(s.is_ready(&data, Some(&real)));
        assert!(!s.can_file_for_review(&data, Some(&real)));
    }

    #[test]
    fn is_not_offered_on_a_lanes_generated_anchor() {
        let (mut s, _, mut fx) = setup();
        let groups = vec![group("g-main", "Main activity").anchor("anchor")];
        let anchor = ready_ws(&mut fx, "anchor")
            .title("Main activity")
            .group("g-main");
        let data = frame(NOW, groups, vec![anchor.clone()]);
        assert!(s.is_ready(&data, Some(&anchor)));
        assert!(!s.can_file_for_review(&data, Some(&anchor)));
    }

    #[test]
    fn still_counts_a_chip_as_a_chips_row() {
        let (mut s, data, _) = setup();
        let w = ws("b").branch("feat");
        assert!(s.has_chips_row(&data, Some(&w), true));
        assert!(!s.has_chips_row(&data, Some(&w), false));
    }
}
