//! test/cockpit.test.ts: the cases that test model.rs, status.rs and the
//! project-of-a-workspace slice. Cases that test the strip, lane entries,
//! the Projects rows, drops, Next, the card menu or new projects are left
//! for the lanes that port those modules.

use cockpit_core::data::{Data, Workspace, WorkspaceGroup};
use cockpit_core::lanes::{LANES, LaneKey, lane_by_key};
use cockpit_core::model::{PanelHeight, actual_lane_of, card_density};
use cockpit_core::persist::ViewMode;
use cockpit_core::session::Session;
use cockpit_core::status::Status;
use serde_json::Value;

use crate::support::*;

const NOW: f64 = 1_000_100.0;

/// Groups mirror cmux: each lane group has a generated anchor workspace.
fn setup() -> (Session, Data, Fx) {
    let data = frame(
        NOW,
        vec![
            group("g-main", "Main activity").anchor("anchor-main"),
            group("g-review", "For review").anchor("anchor-review"),
            group("g-parked", "Parked").anchor("anchor-parked"),
        ],
        vec![
            ws("anchor-main").title("Main activity").group("g-main"),
            ws("a").group("g-main"),
            ws("b").group("g-main"),
            ws("anchor-review").title("For review").group("g-review"),
            ws("c").group("g-review"),
            ws("anchor-parked").title("Parked").group("g-parked"),
            ws("p").group("g-parked"),
            ws("u"),
        ],
    );
    (fresh(), data, Fx::default())
}

fn ids(list: &[&Workspace]) -> Vec<String> {
    list.iter().map(|w| w.id.clone()).collect()
}

fn has(list: &[String], id: &str) -> bool {
    list.iter().any(|x| x == id)
}

mod lanes {
    use super::*;

    #[test]
    fn maps_groups_to_lanes_by_name_and_ungrouped_to_unsorted() {
        let (_, data, _) = setup();
        assert_eq!(
            actual_lane_of(&data, Some(by_id(&data, "a"))),
            LaneKey::Main
        );
        assert_eq!(
            actual_lane_of(&data, Some(by_id(&data, "c"))),
            LaneKey::Review
        );
        assert_eq!(
            actual_lane_of(&data, Some(by_id(&data, "u"))),
            LaneKey::Unsorted
        );
        let unknown = ws("x").group("unknown");
        assert_eq!(actual_lane_of(&data, Some(&unknown)), LaneKey::Unsorted);
    }

    #[test]
    fn hides_lane_anchors_from_the_cards() {
        let (mut s, data, _) = setup();
        assert_eq!(ids(&s.card_workspaces(&data)), ["a", "b", "c", "p", "u"]);
    }

    #[test]
    fn shows_only_the_chosen_modes_panel_hiding_the_other_at_zero_height() {
        let (mut s, _, _) = setup();
        let shown = |s: &Session, m| (s.panel_opacity(m), s.panel_max_height(m));
        assert_eq!(shown(&s, ViewMode::All), (1.0, PanelHeight::Infinity));
        assert_eq!(shown(&s, ViewMode::Projects), (0.0, PanelHeight::Zero));
        s.set_mode(ViewMode::Projects);
        assert_eq!(shown(&s, ViewMode::All), (0.0, PanelHeight::Zero));
        assert_eq!(shown(&s, ViewMode::Projects), (1.0, PanelHeight::Infinity));
    }

    #[test]
    fn marks_one_tab_chosen_at_a_time() {
        let (mut s, _, _) = setup();
        assert_eq!((s.is_mode(ViewMode::All), s.projects_mode()), (true, false));
        s.set_mode(ViewMode::Projects);
        assert_eq!((s.is_mode(ViewMode::All), s.projects_mode()), (false, true));
    }

    #[test]
    fn lane_by_key_falls_back_to_unsorted_and_lanes_ends_with_it() {
        assert_eq!(LANES.last().map(|l| l.key), Some(LaneKey::Unsorted));
        assert_eq!(lane_by_key(LaneKey::Bg).name, "Background");
    }
}

mod a_real_workspace_anchoring_a_single_member_group {
    use super::*;

    /// Partly ported: the Needs you list and the lane's count are strip.ts's and lane-entries.ts's.
    #[test]
    fn hides_the_generated_anchor_but_shows_the_real_one_in_needs_you_and_counted_in_its_lane() {
        let (mut s, _, mut fx) = setup();
        let data = frame(
            NOW,
            vec![
                group("g-main", "Main activity").anchor("gen-main"),
                group("g-parked", "Parked").anchor("real-parked"),
            ],
            vec![
                ws("gen-main")
                    .title("Main activity")
                    .directory("/Users/coder/Dev")
                    .group("g-main"),
                ws("real-parked")
                    .title("PR #155 wireless spike measurement")
                    .directory("/Users/coder/dev/app-three")
                    .group("g-parked")
                    .agents(vec![fx.agent(NeedsInput).since(1.0)]),
            ],
        );
        assert_eq!(s.lane_anchor_ids(&data), ["gen-main"]);
        assert_eq!(ids(&s.card_workspaces(&data)), ["real-parked"]);
        assert_eq!(
            s.lane_of(&data, by_id(&data, "real-parked")),
            LaneKey::Parked
        );
    }
}

mod handle_move {
    use super::*;

    /// Adapted: the drop is drop.ts's, so the card moves by move_to_lane, the lane change a drop makes.
    #[test]
    fn changes_a_dropped_cards_size_only_once_cmuxs_data_has_it_in_the_new_lane() {
        let (mut s, mut data, _) = setup();
        assert_eq!(
            card_density(&data, Some(by_id(&data, "a"))).as_str(),
            "full"
        );
        s.move_to_lane(&data, Some(by_id(&data, "a")), LaneKey::Review);
        assert_eq!(s.lane_of(&data, by_id(&data, "a")), LaneKey::Review);
        assert_eq!(
            card_density(&data, Some(by_id(&data, "a"))).as_str(),
            "full"
        );
        ws_mut(&mut data, "a").group = Some("g-review".into());
        assert_eq!(
            card_density(&data, Some(by_id(&data, "a"))).as_str(),
            "compact"
        );
    }
}

mod missing_lane_groups {
    use super::*;

    // setup() has no Background group, like a fresh cmux window.
    fn add_bg_group(data: &mut Data) {
        if let Some(groups) = data.groups.as_mut() {
            groups.push(group("g-bg", "Background").anchor("anchor-bg"));
        }
    }

    fn param_of(s: &Session, method: &str, param: &str) -> Vec<String> {
        calls(s)
            .into_iter()
            .filter(|(m, _)| m == method)
            .filter_map(|(_, p)| p.into_iter().find(|(k, _)| k == param).map(|(_, v)| v))
            .collect()
    }

    /// Partly ported: the lane's count is lane-entries.ts's.
    #[test]
    fn creates_the_lanes_group_then_files_the_card_once_it_appears() {
        let (mut s, mut data, _) = setup();
        s.move_to_lane(&data, Some(by_id(&data, "u")), LaneKey::Bg);
        let key = format!("cockpit-lane-bg-{NOW}");
        assert_eq!(
            calls(&s),
            [call(
                "workspace.group.create",
                &[("name", "Background"), ("idempotency_key", &key)]
            )]
        );
        // Optimistic while cmux makes the group: the card moves now.
        assert_eq!(s.lane_of(&data, by_id(&data, "u")), LaneKey::Bg);

        s.take_outbox();
        add_bg_group(&mut data);
        if let Some(list) = data.workspaces.as_mut() {
            list.push(ws("anchor-bg").title("Background").group("g-bg"));
        }
        s.card_workspaces(&data);
        // Position first: just after the new anchor, the last tab once u is left out.
        assert_eq!(
            calls(&s),
            [
                call(
                    "workspace.reorder",
                    &[("workspace_id", "u"), ("index", "8")]
                ),
                call(
                    "workspace.group.add",
                    &[("group_id", "g-bg"), ("workspace_id", "u")]
                ),
            ]
        );
        // Sent once, not on every read.
        s.card_workspaces(&data);
        assert_eq!(calls(&s).len(), 2);
    }

    #[test]
    fn asks_for_the_group_once_while_it_is_on_its_way() {
        let (mut s, mut data, _) = setup();
        s.move_to_lane(&data, Some(by_id(&data, "u")), LaneKey::Bg);
        s.move_to_lane(&data, Some(by_id(&data, "a")), LaneKey::Bg);
        assert_eq!(
            methods(&s)
                .iter()
                .filter(|m| *m == "workspace.group.create")
                .count(),
            1
        );
        s.take_outbox();
        add_bg_group(&mut data);
        s.card_workspaces(&data);
        assert_eq!(
            param_of(&s, "workspace.group.add", "workspace_id"),
            ["u", "a"]
        );
    }

    #[test]
    fn asks_again_with_a_fresh_key_once_an_earlier_wait_has_run_out() {
        let (mut s, mut data, _) = setup();
        s.move_to_lane(&data, Some(by_id(&data, "u")), LaneKey::Bg);
        data.epoch = Some(NOW + 60.0);
        s.move_to_lane(&data, Some(by_id(&data, "a")), LaneKey::Bg);
        let keys = param_of(&s, "workspace.group.create", "idempotency_key");
        assert_eq!(keys.len(), 2);
        assert_ne!(keys[0], keys[1]);
    }

    /// Adapted: dragging back is drop.ts's; it moves the card by move_to_lane to Unsorted.
    #[test]
    fn cancels_the_wait_when_the_card_is_dragged_back_to_unsorted() {
        let (mut s, mut data, _) = setup();
        s.move_to_lane(&data, Some(by_id(&data, "u")), LaneKey::Bg);
        s.move_to_lane(&data, Some(by_id(&data, "u")), LaneKey::Unsorted);
        assert_eq!(s.lane_of(&data, by_id(&data, "u")), LaneKey::Unsorted);
        s.take_outbox();
        add_bg_group(&mut data);
        s.card_workspaces(&data);
        assert!(calls(&s).is_empty());
    }

    #[test]
    fn hides_the_new_anchor_if_it_arrives_before_its_group() {
        let (mut s, mut data, _) = setup();
        s.move_to_lane(&data, Some(by_id(&data, "u")), LaneKey::Bg);
        if let Some(list) = data.workspaces.as_mut() {
            list.push(ws("anchor-bg").title("Background"));
        }
        assert!(!has(&ids(&s.card_workspaces(&data)), "anchor-bg"));
    }

    #[test]
    fn keeps_the_card_in_its_new_lane_past_the_usual_wait_while_the_group_is_made() {
        let (mut s, mut data, _) = setup();
        s.move_to_lane(&data, Some(by_id(&data, "u")), LaneKey::Bg);
        data.epoch = Some(NOW + 6.0);
        assert_eq!(s.lane_of(&data, by_id(&data, "u")), LaneKey::Bg);
    }

    #[test]
    fn lets_the_card_fall_back_if_the_group_never_arrives() {
        let (mut s, mut data, _) = setup();
        s.move_to_lane(&data, Some(by_id(&data, "u")), LaneKey::Bg);
        data.epoch = Some(NOW + 60.0);
        assert_eq!(s.lane_of(&data, by_id(&data, "u")), LaneKey::Unsorted);
        s.take_outbox();
        add_bg_group(&mut data);
        s.card_workspaces(&data);
        assert!(calls(&s).is_empty());
    }

    /// Adapted: the drop is drop.ts's; a drop into a lane with no group moves the card by move_to_lane.
    #[test]
    fn files_a_dropped_card_into_a_lane_that_has_no_group_yet() {
        let (mut s, data, _) = setup();
        s.move_to_lane(&data, Some(by_id(&data, "u")), LaneKey::Bg);
        assert!(methods(&s).iter().any(|m| m == "workspace.group.create"));
        assert_eq!(s.lane_of(&data, by_id(&data, "u")), LaneKey::Bg);
    }
}

mod a_lanes_generated_anchor {
    use super::*;

    /// Partly ported: the lane's count and rows are lane-entries.ts's.
    #[test]
    fn stays_off_the_cards_when_an_agent_runs_in_it_and_its_lane_counts_only_real_cards() {
        let (mut s, mut data, mut fx) = setup();
        ws_mut(&mut data, "anchor-review").agents = Some(vec![Some(fx.agent(Working))]);
        assert!(!has(&ids(&s.card_workspaces(&data)), "anchor-review"));
    }

    /// Partly ported: the header row is lane-entries.ts's.
    #[test]
    fn leaves_the_header_plain_when_the_anchor_has_no_agent() {
        let (mut s, data, _) = setup();
        assert!(!has(&ids(&s.card_workspaces(&data)), "anchor-review"));
    }

    /// Partly ported: the header row is lane-entries.ts's.
    #[test]
    fn keeps_a_real_workspace_used_as_an_anchor_as_a_card_with_or_without_an_agent() {
        let (mut s, _, mut fx) = setup();
        let mut data = frame(
            NOW,
            vec![group("g-bg", "Background").anchor("real")],
            vec![ws("real").title("Spike: wireless").group("g-bg")],
        );
        assert_eq!(ids(&s.card_workspaces(&data)), ["real"]);
        ws_mut(&mut data, "real").agents = Some(vec![Some(fx.agent(Working))]);
        assert_eq!(ids(&s.card_workspaces(&data)), ["real"]);
    }

    #[test]
    fn never_moves_out_of_the_group_it_anchors_even_from_the_card_menu() {
        let (mut s, data, _) = setup();
        let anchor = by_id(&data, "anchor-review");
        s.move_to_lane(&data, Some(anchor), LaneKey::Parked);
        assert!(calls(&s).is_empty());
        assert_eq!(s.lane_of(&data, anchor), LaneKey::Review);
    }
}

mod needs_you {
    use super::*;

    #[test]
    fn a_dismissal_holds_until_the_agent_asks_again() {
        let (mut s, mut data, mut fx) = setup();
        ws_mut(&mut data, "a").agents = Some(vec![Some(fx.agent(NeedsInput).since(500.0))]);
        s.dismiss_needs(Some(by_id(&data, "a")));
        assert_eq!(s.status_of(Some(by_id(&data, "a"))), Status::Idle);
        ws_mut(&mut data, "a").agents = Some(vec![Some(fx.agent(NeedsInput).since(900.0))]);
        assert_eq!(s.status_of(Some(by_id(&data, "a"))), Status::NeedsInput);
    }
}

mod move_to_project_override_issue_8 {
    use super::*;

    #[test]
    fn has_no_override_until_one_is_set() {
        let (s, data, _) = setup();
        assert!(!s.has_project_override(Some(by_id(&data, "a"))));
    }

    #[test]
    fn overrides_the_path_match_until_cleared() {
        let (mut s, mut data, _) = setup();
        ws_mut(&mut data, "a").directory = Some("/Users/coder/dev/app-one".into());
        let a = by_id(&data, "a");
        assert_eq!(s.project_key(a), "/dev/app-one");
        s.move_to_project(Some(a), "/dev/app-two");
        assert_eq!(s.project_key(a), "/dev/app-two");
        assert!(s.has_project_override(Some(a)));
        s.clear_project_override(Some(a));
        assert_eq!(s.project_key(a), "/dev/app-one");
        assert!(!s.has_project_override(Some(a)));
    }

    #[test]
    fn gives_the_badge_the_moved_to_project_and_other_with_no_workspace() {
        let (mut s, mut data, _) = setup();
        ws_mut(&mut data, "a").directory = Some("/Users/coder/dev/app-one".into());
        let a = by_id(&data, "a");
        assert_eq!(s.project_of_workspace(Some(a)).name, "App One");
        s.move_to_project(Some(a), "/dev/app-two");
        assert_eq!(s.project_of_workspace(Some(a)).name, "App Two");
        s.clear_project_override(Some(a));
        assert_eq!(s.project_of_workspace(Some(a)).name, "App One");
        assert_eq!(s.project_of_workspace(None).name, "Other");
    }

    #[test]
    fn gives_a_workspace_with_no_path_match_the_other_badge() {
        let (s, data, _) = setup();
        assert_eq!(
            s.project_of_workspace(Some(by_id(&data, "u"))).name,
            "Other"
        );
    }

    #[test]
    fn move_to_project_persists_the_new_key_clear_project_override_a_delete() {
        let (mut s, data, _) = setup();
        let a = by_id(&data, "a");
        s.move_to_project(Some(a), "/dev/app-two");
        assert_eq!(
            opened(&s),
            ["cmux-cockpit://set?key=projectOverride.a&value=%22%2Fdev%2Fapp-two%22"]
        );
        s.take_outbox();
        s.clear_project_override(Some(a));
        assert_eq!(opened(&s), ["cmux-cockpit://set?key=projectOverride.a"]);
    }

    #[test]
    fn ignores_a_key_that_is_not_a_configured_project() {
        let (mut s, mut data, _) = setup();
        ws_mut(&mut data, "a").directory = Some("/Users/coder/dev/app-one".into());
        let a = by_id(&data, "a");
        s.move_to_project(Some(a), "not-a-project");
        assert_eq!(s.project_key(a), "/dev/app-one");
        assert!(!s.has_project_override(Some(a)));
    }

    #[test]
    fn moves_a_workspace_with_no_path_match_into_a_project_too() {
        let (mut s, data, _) = setup();
        let u = by_id(&data, "u");
        assert_eq!(s.project_key(u), "other");
        s.move_to_project(Some(u), "/dev/app-three");
        assert_eq!(s.project_key(u), "/dev/app-three");
    }
}

mod lane_markers {
    use super::*;

    #[test]
    fn are_all_distinct() {
        let colors: std::collections::HashSet<_> = LANES.iter().map(|l| l.color).collect();
        assert_eq!(colors.len(), LANES.len());
    }
}

mod saving_the_view_and_folds {
    use super::*;

    /// The last ui.collapsed write's value.
    fn last_folds(s: &Session) -> Option<Value> {
        sent(s)
            .into_iter()
            .rev()
            .find(|(k, _)| k == "ui.collapsed")
            .and_then(|(_, v)| v)
    }

    #[test]
    fn saves_a_switch_between_all_and_projects_and_not_a_tap_on_the_one_already_shown() {
        let (mut s, _, _) = setup();
        s.choose_mode(ViewMode::All);
        assert!(opened(&s).is_empty());
        s.choose_mode(ViewMode::Projects);
        assert_eq!(s.mode(), ViewMode::Projects);
        assert_eq!(
            sent(&s),
            [("ui.mode".to_string(), Some(Value::from("projects")))]
        );
    }

    #[test]
    fn saves_every_fold_at_once_when_a_lane_or_project_is_toggled() {
        let (mut s, data, _) = setup();
        s.toggle_lane(&data, &lane_by_key(LaneKey::Unsorted));
        s.toggle_project(&data, "/dev/app-two");
        let last = last_folds(&s).unwrap();
        assert_eq!(last["lane:unsorted"], 1);
        assert_eq!(last["project:/dev/app-two"], 1);
    }

    #[test]
    fn saves_the_quiet_fold_under_its_own_key_so_the_stale_project_prune_keeps_it() {
        let (mut s, data, _) = setup();
        s.toggle_quiet(&data);
        assert_eq!(last_folds(&s).unwrap()["quiet"], 1);
        s.toggle_quiet(&data);
        let (key, value) = sent(&s).last().cloned().unwrap();
        assert_eq!(key, "ui.collapsed");
        assert!(value.and_then(|v| v.get("quiet").cloned()).is_none());
    }

    #[test]
    fn drops_folds_on_projects_that_are_gone_and_sorts_the_rest() {
        let (mut s, data, _) = setup();
        s.set_collapsed_projects(vec![
            "/dev/gone".into(),
            "/dev/app-two".into(),
            "/dev/app-one".into(),
        ]);
        s.toggle_lane(&data, &lane_by_key(LaneKey::Unsorted));
        let last = last_folds(&s).unwrap();
        let keys: Vec<String> = last.as_object().unwrap().keys().cloned().collect();
        assert!(!has(&keys, "project:/dev/gone"));
        let mut sorted = keys.clone();
        sorted.sort();
        assert_eq!(keys, sorted);
        assert!(has(&keys, "project:/dev/app-one") && has(&keys, "project:/dev/app-two"));
    }

    #[test]
    fn marks_a_lane_that_starts_folded_as_touched_once_it_is_opened() {
        let (mut s, data, _) = setup();
        let parked = lane_by_key(LaneKey::Parked);
        if s.is_collapsed(&data, &parked) {
            s.toggle_lane(&data, &parked);
        }
        assert_eq!(last_folds(&s).unwrap()["lane:parked"], 0);
    }
}

mod the_selection_override {
    use super::*;

    #[test]
    fn shows_a_tapped_card_as_selected_at_once_then_lapses_if_cmux_never_publishes_the_change() {
        let (mut s, mut data, _) = setup();
        let tapped = ws("tapped");
        let other = ws("other").selected();
        s.select_workspace(&data, Some("tapped"));
        assert!(s.is_selected(&data, Some(&tapped)));
        assert!(!s.is_selected(&data, Some(&other)));
        data.epoch = Some(NOW + 5.0);
        assert!(!s.is_selected(&data, Some(&tapped)));
        assert!(s.is_selected(&data, Some(&other)));
    }

    #[test]
    fn holds_within_the_expiry_window() {
        let (mut s, mut data, _) = setup();
        s.select_workspace(&data, Some("tapped"));
        data.epoch = Some(NOW + 4.0);
        assert!(s.is_selected(&data, Some(&ws("tapped"))));
    }
}

mod data_fields_cmux_may_leave_out_issue_7 {
    use super::*;

    #[test]
    fn shows_an_untitled_workspace_anchoring_a_nameless_group_as_a_card() {
        let (mut s, mut data, _) = setup();
        if let Some(groups) = data.groups.as_mut() {
            groups.push(WorkspaceGroup {
                id: "g-x".into(),
                anchor_id: Some("real".into()),
                ..WorkspaceGroup::default()
            });
        }
        if let Some(list) = data.workspaces.as_mut() {
            list.push(ws("real").title("").group("g-x"));
        }
        assert!(!has(&s.lane_anchor_ids(&data), "real"));
        assert!(has(&ids(&s.card_workspaces(&data)), "real"));
    }

    #[test]
    fn leaves_out_an_agent_with_no_status_no_agent_alone_and_never_counted_live() {
        let (mut s, data, mut fx) = setup();
        let bare = bare_agent("bare").since(NOW - 720.0);
        let w = ws("w").agents(vec![bare.clone(), fx.agent(Working)]);
        assert_eq!(s.status_of(Some(&w)), Status::Working);
        let v = ws("v").agents(vec![bare]);
        assert_eq!(s.status_of(Some(&v)), Status::None);
        let plain = s.status_line(&data, Some(&ws("v")));
        assert_eq!(s.status_line(&data, Some(&v)), plain);
        assert!(s.agents_of(Some(&v)).is_empty());
    }
}
