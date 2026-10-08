//! test/merge-ready.test.ts: a lane header's "N ready to merge", from the
//! cards whose saved PR GitHub would merge now, and the words at the
//! header's trailing edge.

use cockpit_core::data::Data;
use cockpit_core::lane_entries::{HeaderHint, LaneEntry};
use cockpit_core::lanes::LaneKey;
use cockpit_core::session::Session;
use cockpit_core::theme::Token;

use crate::support::*;

const NOW: f64 = 1_000_100.0;

const STATE: &str = r#"{"prs": {
    "ready1": {"url": "https://github.com/o/r/pull/1", "status": "open", "branch": "feat", "checks": [{"name": "build", "state": "pass"}], "number": 1, "mergeable": true},
    "ready2": {"url": "https://github.com/o/r/pull/1", "status": "open", "branch": "feat", "checks": [{"name": "build", "state": "pass"}], "number": 2, "mergeable": true},
    "draft": {"url": "https://github.com/o/r/pull/1", "status": "open", "branch": "feat", "checks": [{"name": "build", "state": "pass"}], "number": 3, "mergeable": true, "draft": true},
    "failing": {"url": "https://github.com/o/r/pull/1", "status": "open", "branch": "feat", "checks": [{"name": "build", "state": "fail"}], "number": 4, "mergeable": true},
    "merged": {"url": "https://github.com/o/r/pull/1", "status": "merged", "branch": "feat", "checks": [{"name": "build", "state": "pass"}], "number": 5, "mergeable": true},
    "readyMain": {"url": "https://github.com/o/r/pull/1", "status": "open", "branch": "feat", "checks": [{"name": "build", "state": "pass"}], "number": 6, "mergeable": true},
    "conflicts": {"url": "https://github.com/o/r/pull/1", "status": "open", "branch": "feat", "checks": [{"name": "build", "state": "pass"}], "number": 7, "mergeable": true, "conflicts": true},
    "running": {"url": "https://github.com/o/r/pull/1", "status": "open", "branch": "feat", "checks": [{"name": "build", "state": "pending"}], "number": 8, "mergeable": true},
    "noVerdict": {"url": "https://github.com/o/r/pull/1", "status": "open", "branch": "feat", "checks": [{"name": "build", "state": "pass"}], "number": 9},
    "blocked": {"url": "https://github.com/o/r/pull/1", "status": "open", "branch": "feat", "checks": [{"name": "build", "state": "pass"}], "number": 10, "mergeable": false},
    "noChecks": {"url": "https://github.com/o/r/pull/1", "status": "open", "branch": "feat", "checks": [], "number": 11, "mergeable": true},
    "anchor-parked": {"url": "https://github.com/o/r/pull/1", "status": "open", "branch": "feat", "checks": [{"name": "build", "state": "pass"}], "number": 12, "mergeable": true}
}}"#;

fn setup() -> (Session, Data, Fx) {
    let data = frame(
        NOW,
        vec![
            group("g-main", "Main activity").anchor("anchor-main"),
            group("g-review", "For review").anchor("anchor-review"),
            group("g-bg", "Background").anchor("anchor-bg"),
            group("g-parked", "Parked").anchor("anchor-parked"),
        ],
        vec![
            ws("anchor-main").title("Main activity").group("g-main"),
            ws("readyMain").group("g-main"),
            ws("anchor-review").title("For review").group("g-review"),
            ws("ready1").group("g-review"),
            ws("ready2").group("g-review"),
            ws("draft").group("g-review"),
            ws("failing").group("g-review"),
            ws("merged").group("g-review"),
            ws("anchor-bg").title("Background").group("g-bg"),
            ws("conflicts").group("g-bg"),
            ws("running").group("g-bg"),
            ws("noVerdict").group("g-bg"),
            ws("blocked").group("g-bg"),
            ws("noChecks").group("g-bg"),
            // A generated anchor has no card; its PR still counts on the header.
            ws("anchor-parked").title("Parked").group("g-parked"),
        ],
    );
    (session(STATE), data, Fx::default())
}

mod merge_ready_text {
    use super::*;

    #[test]
    fn counts_only_the_lanes_prs_that_are_out_of_draft_passing_and_mergeable() {
        let (mut s, data, _) = setup();
        assert_eq!(
            s.merge_ready_text(&data, &LaneKey::from("review")),
            "2 ready to merge"
        );
    }

    #[test]
    fn counts_each_lane_on_its_own() {
        let (mut s, data, _) = setup();
        assert_eq!(
            s.merge_ready_text(&data, &LaneKey::from("main")),
            "1 ready to merge"
        );
    }

    #[test]
    fn says_nothing_when_the_lanes_prs_are_in_conflict_running_blocked_without_a_verdict_or_without_checks()
     {
        let (mut s, data, _) = setup();
        assert_eq!(s.merge_ready_text(&data, &LaneKey::from("bg")), "");
    }

    #[test]
    fn says_nothing_for_a_lane_with_no_workspaces() {
        let (mut s, data, _) = setup();
        assert_eq!(s.merge_ready_text(&data, &LaneKey::unsorted()), "");
    }

    #[test]
    fn counts_the_lanes_generated_anchor_which_has_no_card_of_its_own() {
        let (mut s, data, _) = setup();
        assert_eq!(
            s.merge_ready_text(&data, &LaneKey::from("parked")),
            "1 ready to merge"
        );
    }

    #[test]
    fn still_counts_a_waiting_card_a_waiting_sessions_pr_is_still_mergeable() {
        let (mut s, mut data, mut fx) = setup();
        ws_mut(&mut data, "readyMain").agents =
            Some(vec![Some(fx.agent(NeedsInput).since(NOW - 30.0))]);
        assert!(s.needs_list(&data).iter().any(|w| w.id == "readyMain"));
        assert!(
            s.lane_entries(&data)
                .iter()
                .any(|e| matches!(e, LaneEntry::Ws { ws_id, .. } if ws_id == "readyMain"))
        );
        assert_eq!(
            s.merge_ready_text(&data, &LaneKey::from("main")),
            "1 ready to merge"
        );
    }

    #[test]
    fn drops_a_card_once_it_has_moved_to_another_branch() {
        let (mut s, mut data, _) = setup();
        ws_mut(&mut data, "ready2").branch = Some("other".into());
        assert_eq!(
            s.merge_ready_text(&data, &LaneKey::from("review")),
            "1 ready to merge"
        );
    }
}

mod header_hint {
    use super::*;

    #[test]
    fn says_drop_here_while_a_drag_is_over_the_lane_whatever_is_ready() {
        let (mut s, data, _) = setup();
        assert_eq!(
            s.header_hint(&data, &LaneKey::from("review"), true),
            HeaderHint {
                text: "Drop here".into(),
                color: Token::Heading,
            }
        );
    }

    /// Partly ported: the contrast ratio between the two greens is a
    /// property of their hex, which stays with whoever draws; here the
    /// token, and that it is not the agent's Ready green.
    #[test]
    fn gives_the_merge_line_in_readys_green_not_the_agents_ready_green() {
        let (mut s, data, _) = setup();
        let hint = s.header_hint(&data, &LaneKey::from("review"), false);
        assert_eq!(hint.text, "2 ready to merge");
        assert_eq!(hint.color, Token::GreenDeep);
        assert_ne!(hint.color, Token::GreenText);
    }

    #[test]
    fn keeps_parkeds_merge_line_faint() {
        let (mut s, data, _) = setup();
        assert_eq!(
            s.header_hint(&data, &LaneKey::from("parked"), false),
            HeaderHint {
                text: "1 ready to merge".into(),
                color: Token::Faint,
            }
        );
    }
}

/// Ready to merge on the status line (issue #299).
mod merge_ready_status {
    use super::*;
    use cockpit_core::card_chips::Chip;
    use cockpit_core::data::{Agent, AgentStatus, Workspace};
    use cockpit_core::prs::pr_summary;
    use cockpit_core::status::{StatusKind, compact_pr_text};
    use cockpit_core::ui::Urgency;

    /// The workspace `id` with `agents`, and `unread` unread.
    fn card(data: &mut Data, id: &str, agents: Vec<Agent>, unread: f64) -> Workspace {
        let w = ws_mut(data, id);
        w.agents = Some(agents.into_iter().map(Some).collect());
        w.unread = Some(unread);
        w.clone()
    }

    /// An agent of `status` whose status began, and whose last activity
    /// was, `ago` seconds back.
    fn at(fx: &mut Fx, status: AgentStatus, ago: f64) -> Agent {
        fx.agent(status).since(NOW - ago).activity(NOW - ago)
    }

    #[test]
    fn says_ready_to_merge_on_an_idle_card_whose_pr_github_would_merge_in_the_vivid_green() {
        let (mut s, mut data, mut fx) = setup();
        let w = card(&mut data, "ready1", vec![at(&mut fx, Idle, 180.0)], 0.0);
        let info = s.status_info(&data, Some(&w));
        assert_eq!(info.label, "Ready to merge");
        assert_eq!(info.dot, Some(Token::MergeGreen));
        assert_eq!(info.halo, Token::MergeHalo);
        assert_eq!(info.text, Token::MergeText);
        assert_eq!(info.urgency, Urgency::Quiet);
        assert_eq!(s.status_line(&data, Some(&w)), "Ready to merge 3m");
    }

    #[test]
    fn says_it_on_a_finished_card_and_one_with_no_agent_too() {
        let (mut s, mut data, mut fx) = setup();
        let ended = card(&mut data, "ready1", vec![at(&mut fx, Ended, 60.0)], 0.0);
        let none = card(&mut data, "ready2", vec![], 0.0);
        for w in [ended, none] {
            assert_eq!(
                s.status_kind(&data, Some(&w)),
                StatusKind::MergeReady,
                "{}",
                w.id
            );
        }
    }

    #[test]
    fn leaves_a_working_or_waiting_card_its_own_status() {
        let (mut s, mut data, mut fx) = setup();
        let working = card(&mut data, "ready1", vec![at(&mut fx, Working, 60.0)], 0.0);
        let turn = card(
            &mut data,
            "ready2",
            vec![at(&mut fx, NeedsInput, 60.0)],
            0.0,
        );
        assert_eq!(s.status_info(&data, Some(&working)).label, "Working");
        assert_eq!(s.status_info(&data, Some(&turn)).label, "Your turn");
    }

    #[test]
    fn leaves_an_agent_whose_status_it_does_not_know_as_it_was_since_it_may_yet_be_busy() {
        let (mut s, mut data, mut fx) = setup();
        let thinking = at(&mut fx, AgentStatus::Other("thinking".into()), 60.0);
        let w = card(&mut data, "ready1", vec![thinking], 0.0);
        assert_ne!(s.status_kind(&data, Some(&w)), StatusKind::MergeReady);
    }

    #[test]
    fn says_nothing_of_a_pr_that_is_not_ready() {
        let (mut s, mut data, mut fx) = setup();
        for id in [
            "draft",
            "failing",
            "conflicts",
            "running",
            "blocked",
            "noVerdict",
        ] {
            let w = card(&mut data, id, vec![at(&mut fx, Idle, 60.0)], 0.0);
            assert_eq!(s.status_info(&data, Some(&w)).label, "Idle", "{id}");
        }
    }

    #[test]
    fn wins_over_ready_and_the_unread_badge_then_says_there_is_output() {
        let (mut s, mut data, mut fx) = setup();
        let w = card(&mut data, "ready1", vec![at(&mut fx, Idle, 120.0)], 2.0);
        assert!(
            s.is_ready(&data, Some(&w)),
            "the agent finished with output unread"
        );
        assert_eq!(s.status_kind(&data, Some(&w)), StatusKind::MergeReady);
        assert!(!s.shows_ready(&data, Some(&w)), "no Ready pill");
        assert_eq!(s.badge_count(&data, Some(&w)), 2.0);
    }

    #[test]
    fn keeps_a_ready_cards_pill_when_its_pr_is_not_ready() {
        let (mut s, mut data, mut fx) = setup();
        let w = card(&mut data, "failing", vec![at(&mut fx, Idle, 120.0)], 2.0);
        assert!(s.shows_ready(&data, Some(&w)));
        assert_eq!(s.badge_count(&data, Some(&w)), 0.0);
    }

    #[test]
    fn drops_the_prs_state_words_once_the_status_says_it_keeping_its_number_decided_1a() {
        let (mut s, mut data, mut fx) = setup();
        let words = |s: &mut Session, w: &Workspace| {
            let pr = pr_summary(&s.saved, Some(w)).expect("a PR");
            compact_pr_text(Some(&s.card_pr_words(Some(w), &pr)))
        };
        let state = |s: &mut Session, w: &Workspace| {
            s.chips_for(Some(w), true)
                .into_iter()
                .find_map(|c| match c {
                    Chip::Pr { tag, state, .. } => Some((tag, state)),
                    _ => None,
                })
        };
        let ready = card(&mut data, "ready1", vec![at(&mut fx, Idle, 180.0)], 0.0);
        assert_eq!(
            words(&mut s, &ready),
            "· #1",
            "compact: Ready to merge 3m · #1"
        );
        assert_eq!(state(&mut s, &ready), Some(("#1".into(), String::new())));
        // Working on the same ready PR, the status says Working, so the chip keeps "ready".
        let busy = card(&mut data, "ready2", vec![at(&mut fx, Working, 60.0)], 0.0);
        assert_eq!(words(&mut s, &busy), "· #2 · ready");
        assert_eq!(state(&mut s, &busy), Some(("#2".into(), "ready".into())));
    }

    #[test]
    fn leaves_a_headers_pill_grey() {
        let (mut s, mut data, mut fx) = setup();
        let w = card(&mut data, "ready1", vec![at(&mut fx, Idle, 60.0)], 0.0);
        assert_eq!(s.urgency_of(&data, Some(&w)), Urgency::Quiet);
    }
}
