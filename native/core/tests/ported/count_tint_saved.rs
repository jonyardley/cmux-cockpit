//! test/count-tint-saved.test.ts: one saved ask, so an ask that began with
//! it reads amber.

use cockpit_core::data::{Data, Workspace};
use cockpit_core::session::Session;
use cockpit_core::theme::Token;
use cockpit_core::ui::{PillColors, QUIET_PILL, Urgency, count_tint};

use crate::support::*;

const STATE: &str = r#"{"asking": {"ask": {"reason": "allow git push?", "epoch": 1000}}}"#;

fn setup() -> (Session, Data, Fx) {
    (session(STATE), frame(1060.0, vec![], vec![]), Fx::default())
}

fn needs_ws(fx: &mut Fx) -> Workspace {
    ws("needs").agents(vec![fx.agent(NeedsInput).since(1000.0)])
}
fn ask_ws(fx: &mut Fx) -> Workspace {
    ws("ask").agents(vec![fx.agent(NeedsInput).since(1000.0).activity(1000.0)])
}
fn working_ws(fx: &mut Fx) -> Workspace {
    ws("working").agents(vec![fx.agent(Working).since(1000.0)])
}
fn idle_ws(fx: &mut Fx) -> Workspace {
    ws("idle").agents(vec![fx.agent(Idle), fx.agent(Ended)])
}
/// Working, but silent past QUIET_SECS: the hollow blue dot, still working.
fn quiet_ws(fx: &mut Fx) -> Workspace {
    ws("quiet").agents(vec![fx.agent(Working).since(100.0).activity(400.0)])
}
/// Finished with output unread: Ready, the finished green.
fn ready_ws(fx: &mut Fx) -> Workspace {
    ws("ready")
        .unread(2.0)
        .agents(vec![fx.agent(Idle).activity(1000.0)])
}

fn clay() -> PillColors {
    PillColors {
        bg: Token::ClayCount,
        fg: Token::ClayText,
    }
}
fn amber() -> PillColors {
    PillColors {
        bg: Token::AmberCount,
        fg: Token::AmberText,
    }
}
fn blue() -> PillColors {
    PillColors {
        bg: Token::BlueCount,
        fg: Token::BlueText,
    }
}

mod urgency_of {
    use super::*;

    #[test]
    fn reads_needs_you_asking_and_working_by_status_infos_order() {
        let (mut s, data, mut fx) = setup();
        assert_eq!(
            s.urgency_of(&data, Some(&needs_ws(&mut fx))),
            Urgency::Needs
        );
        assert_eq!(s.urgency_of(&data, Some(&ask_ws(&mut fx))), Urgency::Asking);
        assert_eq!(
            s.urgency_of(&data, Some(&working_ws(&mut fx))),
            Urgency::Working
        );
    }

    #[test]
    fn leaves_finished_idle_and_no_agent_quiet() {
        let (mut s, data, mut fx) = setup();
        assert_eq!(s.urgency_of(&data, Some(&idle_ws(&mut fx))), Urgency::Quiet);
        assert_eq!(s.urgency_of(&data, Some(&ws("none"))), Urgency::Quiet);
        assert_eq!(s.urgency_of(&data, None), Urgency::Quiet);
    }

    #[test]
    fn reads_a_quiet_working_agent_as_working_and_ready_as_quiet() {
        let (mut s, data, mut fx) = setup();
        let quiet = quiet_ws(&mut fx);
        assert_eq!(s.status_info(&data, Some(&quiet)).ring, Some(Token::Blue));
        assert_eq!(s.urgency_of(&data, Some(&quiet)), Urgency::Working);
        let ready = ready_ws(&mut fx);
        assert!(s.is_ready(&data, Some(&ready)));
        assert_eq!(s.urgency_of(&data, Some(&ready)), Urgency::Quiet);
    }

    #[test]
    fn is_always_the_urgency_the_cards_status_carries_so_the_pill_and_the_dot_agree() {
        let (mut s, data, mut fx) = setup();
        let all = [
            needs_ws(&mut fx),
            ask_ws(&mut fx),
            working_ws(&mut fx),
            idle_ws(&mut fx),
            quiet_ws(&mut fx),
            ready_ws(&mut fx),
            ws("none"),
        ];
        for w in &all {
            let info = s.status_info(&data, Some(w)).urgency;
            assert_eq!(s.urgency_of(&data, Some(w)), info, "{}", w.id);
        }
    }
}

mod most_urgent {
    use super::*;

    #[test]
    fn ranks_needs_you_over_asking_over_working() {
        let (mut s, data, mut fx) = setup();
        let (w, a, n, i) = (
            working_ws(&mut fx),
            ask_ws(&mut fx),
            needs_ws(&mut fx),
            idle_ws(&mut fx),
        );
        assert_eq!(s.most_urgent(&data, &[&w, &a, &n, &i]), Urgency::Needs);
        assert_eq!(s.most_urgent(&data, &[&i, &w, &a]), Urgency::Asking);
        assert_eq!(s.most_urgent(&data, &[&i, &w]), Urgency::Working);
    }

    #[test]
    fn is_quiet_with_nothing_urgent_or_nothing_at_all() {
        let (mut s, data, mut fx) = setup();
        let i = idle_ws(&mut fx);
        assert_eq!(s.most_urgent(&data, &[&i, &ws("none")]), Urgency::Quiet);
        assert_eq!(s.most_urgent(&data, &[]), Urgency::Quiet);
    }
}

mod count_colors {
    use super::*;

    #[test]
    fn tints_the_pill_by_its_most_urgent_sessions_hue() {
        let (mut s, data, mut fx) = setup();
        assert_eq!(s.count_colors(&data, &[&needs_ws(&mut fx)]), clay());
        assert_eq!(s.count_colors(&data, &[&ask_ws(&mut fx)]), amber());
        assert_eq!(s.count_colors(&data, &[&working_ws(&mut fx)]), blue());
    }

    #[test]
    fn is_the_grey_pill_with_nothing_urgent() {
        let (mut s, data, mut fx) = setup();
        assert_eq!(s.count_colors(&data, &[&idle_ws(&mut fx)]), QUIET_PILL);
        assert_eq!(
            QUIET_PILL,
            PillColors {
                bg: Token::CountBg,
                fg: Token::MetaText
            }
        );
    }
}

mod count_tint_the_shared_rule_both_sides_tint_a_count_pill_by {
    use super::*;

    #[test]
    fn gives_each_urgency_its_hues_pill_and_quiet_the_grey_one() {
        assert_eq!(count_tint(Urgency::Needs), clay());
        assert_eq!(count_tint(Urgency::Asking), amber());
        assert_eq!(count_tint(Urgency::Working), blue());
        assert_eq!(count_tint(Urgency::Quiet), QUIET_PILL);
    }

    #[test]
    fn is_where_the_cockpits_header_tint_comes_from() {
        let (mut s, data, mut fx) = setup();
        assert_eq!(
            s.count_colors(&data, &[&working_ws(&mut fx)]),
            count_tint(Urgency::Working)
        );
        let n = needs_ws(&mut fx);
        assert_eq!(
            s.header_status(&data, &[&n], false).tint,
            count_tint(Urgency::Needs)
        );
    }
}

mod most_urgent_of {
    use super::*;

    #[test]
    fn picks_the_first_workspace_at_the_highest_urgency_for_a_folded_headers_dot() {
        let (mut s, data, mut fx) = setup();
        let i = idle_ws(&mut fx);
        let w = working_ws(&mut fx);
        let mut later = working_ws(&mut fx);
        later.id = "working-2".into();
        let lead = s.most_urgent_of(&data, &[&i, &w, &later]);
        assert_eq!(lead.map(|x| x.id.as_str()), Some("working"));
        let (a, n) = (ask_ws(&mut fx), needs_ws(&mut fx));
        let lead = s.most_urgent_of(&data, &[&w, &a, &n]);
        assert_eq!(lead.map(|x| x.id.as_str()), Some("needs"));
    }

    #[test]
    fn is_undefined_when_every_workspace_is_quiet_so_a_folded_header_shows_no_dot() {
        let (mut s, data, mut fx) = setup();
        let (i, r) = (idle_ws(&mut fx), ready_ws(&mut fx));
        assert_eq!(s.most_urgent_of(&data, &[&i, &r, &ws("none")]), None);
        assert_eq!(s.most_urgent_of(&data, &[]), None);
    }
}

mod header_status {
    use super::*;

    #[test]
    fn shows_the_leads_dot_while_folded_from_the_same_walk_as_the_tint() {
        let (mut s, data, mut fx) = setup();
        let (i, w, a) = (idle_ws(&mut fx), working_ws(&mut fx), ask_ws(&mut fx));
        let shown = s.header_status(&data, &[&i, &w, &a], true);
        assert_eq!(shown.dot.map(|x| x.id.as_str()), Some("ask"));
        assert_eq!(shown.tint, s.count_colors(&data, &[&i, &w, &a]));
    }

    #[test]
    fn shows_no_dot_while_open_and_keeps_the_tint() {
        let (mut s, data, mut fx) = setup();
        let (w, n) = (working_ws(&mut fx), needs_ws(&mut fx));
        let shown = s.header_status(&data, &[&w, &n], false);
        assert_eq!(shown.dot, None);
        assert_eq!(shown.tint, clay());
    }

    #[test]
    fn shows_no_dot_when_every_card_is_quiet_folded_or_not_and_a_grey_tint() {
        let (mut s, data, mut fx) = setup();
        let (i, r) = (idle_ws(&mut fx), ready_ws(&mut fx));
        assert_eq!(s.header_status(&data, &[&i, &r], true).dot, None);
        assert_eq!(s.header_status(&data, &[], true).dot, None);
        assert_eq!(s.header_status(&data, &[&i], true).tint, QUIET_PILL);
    }

    #[test]
    fn tints_as_count_colors_does_for_every_urgency() {
        let (mut s, data, mut fx) = setup();
        let (n, a, w, i) = (
            needs_ws(&mut fx),
            ask_ws(&mut fx),
            working_ws(&mut fx),
            idle_ws(&mut fx),
        );
        let sets: [Vec<&Workspace>; 5] = [vec![&n], vec![&a], vec![&w], vec![&i], vec![]];
        for cards in &sets {
            let tint = s.header_status(&data, cards, true).tint;
            assert_eq!(tint, s.count_colors(&data, cards));
        }
    }
}

mod lane_and_project_count_pills {
    use super::*;
    use cockpit_core::lanes::{LaneKey, lane_by_key};

    /// Four older asks in Unsorted fill the Needs you strip, so a later
    /// one is past its cap and keeps its card, count and tint in its lane.
    fn full_strip(fx: &mut Fx) -> Vec<Workspace> {
        ["s1", "s2", "s3", "s4"]
            .iter()
            .map(|id| ws(id).agents(vec![fx.agent(NeedsInput).since(900.0)]))
            .collect()
    }

    /// A generated anchor has no card, so it is neither counted nor tinted.
    fn seed(fx: &mut Fx) -> Data {
        frame(
            1060.0,
            vec![
                group("g-main", "Main activity").anchor("anchor-main"),
                group("g-parked", "Parked").anchor("anchor-parked"),
            ],
            vec![
                ws("anchor-main").title("Main activity").group("g-main"),
                working_ws(fx)
                    .group("g-main")
                    .directory("/Users/coder/dev/app-two"),
                idle_ws(fx)
                    .group("g-main")
                    .directory("/Users/coder/dev/app-two"),
                ws("anchor-parked").title("Parked").group("g-parked"),
                needs_ws(fx)
                    .group("g-parked")
                    .directory("/Users/coder/dev/app-three"),
            ],
        )
    }

    fn lane_ids(s: &mut Session, data: &Data, key: LaneKey) -> Vec<String> {
        s.lane_workspaces(data, key)
            .iter()
            .map(|w| w.id.clone())
            .collect()
    }

    fn lane_tint(s: &mut Session, data: &Data, key: LaneKey) -> PillColors {
        let cards = s.lane_workspaces(data, key);
        s.count_colors(data, &cards)
    }

    #[test]
    fn lists_the_same_cards_the_lane_counts_and_tints_by_them() {
        let (mut s, _, mut fx) = setup();
        let data = seed(&mut fx);
        assert_eq!(lane_ids(&mut s, &data, LaneKey::Main), ["working", "idle"]);
        assert_eq!(lane_tint(&mut s, &data, LaneKey::Main), blue());
        assert_eq!(lane_tint(&mut s, &data, LaneKey::Review), QUIET_PILL);
    }

    #[test]
    fn counts_and_tints_by_a_placeholder_for_a_card_the_needs_you_strip_lists() {
        let (mut s, _, mut fx) = setup();
        let data = seed(&mut fx);
        assert_eq!(lane_ids(&mut s, &data, LaneKey::Parked), ["needs"]);
        assert_eq!(lane_tint(&mut s, &data, LaneKey::Parked), clay());
    }

    #[test]
    fn counts_and_tints_by_a_card_past_the_strips_cap_which_keeps_its_lane() {
        let (mut s, _, mut fx) = setup();
        let mut data = seed(&mut fx);
        let strip = full_strip(&mut fx);
        data.workspaces.get_or_insert_with(Vec::new).extend(strip);
        assert_eq!(lane_ids(&mut s, &data, LaneKey::Parked), ["needs"]);
        assert_eq!(lane_tint(&mut s, &data, LaneKey::Parked), clay());
    }

    #[test]
    fn keeps_the_tint_while_the_lane_is_folded() {
        let (mut s, _, mut fx) = setup();
        let mut data = seed(&mut fx);
        let strip = full_strip(&mut fx);
        data.workspaces.get_or_insert_with(Vec::new).extend(strip);
        let parked = lane_by_key(LaneKey::Parked);
        if !s.is_collapsed(&data, &parked) {
            s.toggle_lane(&data, &parked);
        }
        assert!(s.is_collapsed(&data, &parked));
        assert_eq!(lane_tint(&mut s, &data, LaneKey::Parked), clay());
    }
}
