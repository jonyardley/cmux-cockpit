//! test/cockpit.test.ts: the cases that test model.rs, status.rs, strip.rs,
//! lane_entries.rs, next.rs, by_project.rs, menu.rs and pr_colors.rs.
//! Cases that test drops are left for the lane that ports them.

use crate::support::lane_by_key;
use cockpit_core::by_project::ProjectEntry;
use cockpit_core::data::{Data, Workspace, WorkspaceGroup};
use cockpit_core::lane_entries::LaneEntry;
use cockpit_core::lanes::{LaneKey, Lanes};
use cockpit_core::model::{PanelHeight, actual_lane_of, card_density};
use cockpit_core::next::{Colour, Origin};
use cockpit_core::persist::ViewMode;
use cockpit_core::session::Session;
use cockpit_core::state::DragState;
use cockpit_core::status::Status;
use cockpit_core::strip::NEEDS_LATE_SECS;
use cockpit_core::theme::Token;
use cockpit_core::time::now_epoch;
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

/// The card menu's items in words, as the sidebar test's `r.menu` lists
/// them: "button:<label>", dividers left out.
fn card_menu(s: &mut Session, data: &Data, w: Option<&Workspace>) -> Vec<String> {
    menu_words(&s.card_menu(data, w))
}

fn ids(list: &[&Workspace]) -> Vec<String> {
    list.iter().map(|w| w.id.clone()).collect()
}

fn has(list: &[String], id: &str) -> bool {
    list.iter().any(|x| x == id)
}

/// All's rows by key. A card's key leaves its lane out, so it survives a
/// lane move; here it shows its lane as well, so the lists still say where
/// each card sits.
fn entry_ids(s: &mut Session, data: &Data) -> Vec<String> {
    s.lane_entries(data)
        .into_iter()
        .map(|e| match e {
            LaneEntry::Ws { ws_id, lane, .. } => format!("{ws_id}@{}", lane.as_str()),
            other => other.id().to_string(),
        })
        .collect()
}

/// The header row of a lane.
fn header(s: &mut Session, data: &Data, lane: LaneKey) -> Option<LaneEntry> {
    s.lane_entries(data)
        .into_iter()
        .find(|e| matches!(e, LaneEntry::Header { .. }) && *e.lane() == lane)
}

/// The Projects view's rows by key.
fn project_ids(s: &mut Session, data: &Data) -> Vec<String> {
    s.project_entries(data)
        .iter()
        .map(|e| e.id().to_string())
        .collect()
}

/// The key of the row after `id`, if any.
fn after(list: &[String], id: &str) -> Option<String> {
    let at = position(list, id)?;
    list.get(at + 1).cloned()
}

fn position(list: &[String], id: &str) -> Option<usize> {
    list.iter().position(|x| x == id)
}

mod lanes {
    use super::*;

    #[test]
    fn maps_groups_to_lanes_by_name_and_ungrouped_to_unsorted() {
        let (_, data, _) = setup();
        assert_eq!(
            actual_lane_of(&Lanes::default(), &data, Some(by_id(&data, "a"))),
            LaneKey::from("main")
        );
        assert_eq!(
            actual_lane_of(&Lanes::default(), &data, Some(by_id(&data, "c"))),
            LaneKey::from("review")
        );
        assert_eq!(
            actual_lane_of(&Lanes::default(), &data, Some(by_id(&data, "u"))),
            LaneKey::unsorted()
        );
        let unknown = ws("x").group("unknown");
        assert_eq!(
            actual_lane_of(&Lanes::default(), &data, Some(&unknown)),
            LaneKey::unsorted()
        );
    }

    #[test]
    fn hides_lane_anchors_from_the_cards() {
        let (mut s, data, _) = setup();
        assert_eq!(ids(&s.card_workspaces(&data)), ["a", "b", "c", "p", "u"]);
    }

    #[test]
    fn lists_every_header_with_parked_collapsed_until_touched() {
        let (mut s, data, _) = setup();
        assert_eq!(
            entry_ids(&mut s, &data),
            [
                "h:main",
                "a@main",
                "b@main",
                "h:review",
                "c@review",
                "z:bg",
                "h:parked",
                "h:unsorted",
                "u@unsorted",
            ]
        );
    }

    #[test]
    fn stays_built_under_projects_so_the_hidden_lanes_need_no_rebuild() {
        let (mut s, data, _) = setup();
        let all = entry_ids(&mut s, &data);
        assert!(!all.is_empty());
        s.set_mode(ViewMode::Projects);
        assert_eq!(entry_ids(&mut s, &data), all);
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
        let lanes = Lanes::default();
        assert_eq!(
            lanes.iter().last().map(|l| &l.key),
            Some(&LaneKey::unsorted())
        );
        assert_eq!(lane_by_key(LaneKey::from("bg")).name, "Background");
    }
}

mod a_real_workspace_anchoring_a_single_member_group {
    use super::*;

    #[test]
    fn hides_the_generated_anchor_but_shows_the_real_one_in_needs_you_and_counted_in_its_lane() {
        let (mut s, _, mut fx) = setup();
        let mut data = frame(
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
        assert_eq!(
            s.lane_anchor_ids(&data).into_iter().collect::<Vec<_>>(),
            ["gen-main"]
        );
        assert_eq!(ids(&s.card_workspaces(&data)), ["real-parked"]);
        assert_eq!(
            s.lane_of(&data, by_id(&data, "real-parked")),
            LaneKey::from("parked")
        );
        assert_eq!(ids(&s.needs_list(&data)), ["real-parked"]);
        // Waiting, it shows in Needs you and its lane counts its placeholder;
        // answered, its card is back in the same count.
        assert_eq!(s.lane_workspaces(&data, &LaneKey::from("parked")).len(), 1);
        ws_mut(&mut data, "real-parked").agents = Some(vec![Some(fx.agent(Working).since(1.0))]);
        assert_eq!(s.lane_workspaces(&data, &LaneKey::from("parked")).len(), 1);
    }
}

mod handle_move {
    use super::*;

    /// Adapted: the drop is drop.ts's, so the card moves by move_to_lane, the lane change a drop makes.
    #[test]
    fn changes_a_dropped_cards_size_only_once_cmuxs_data_has_it_in_the_new_lane() {
        let (mut s, mut data, _) = setup();
        assert_eq!(
            card_density(&Lanes::default(), &data, Some(by_id(&data, "a"))).as_str(),
            "full"
        );
        s.move_to_lane(&data, Some(by_id(&data, "a")), LaneKey::from("review"));
        assert_eq!(s.lane_of(&data, by_id(&data, "a")), LaneKey::from("review"));
        assert_eq!(
            card_density(&Lanes::default(), &data, Some(by_id(&data, "a"))).as_str(),
            "full"
        );
        ws_mut(&mut data, "a").group = Some("g-review".into());
        assert_eq!(
            card_density(&Lanes::default(), &data, Some(by_id(&data, "a"))).as_str(),
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

    #[test]
    fn creates_the_lanes_group_then_files_the_card_once_it_appears() {
        let (mut s, mut data, _) = setup();
        s.move_to_lane(&data, Some(by_id(&data, "u")), LaneKey::from("bg"));
        let key = format!("cockpit-lane-bg-{NOW}");
        assert_eq!(
            calls(&s),
            [call(
                "workspace.group.create",
                &[("name", "Background"), ("idempotency_key", &key)]
            )]
        );
        // Optimistic while cmux makes the group: the card and count move now.
        assert_eq!(s.lane_of(&data, by_id(&data, "u")), LaneKey::from("bg"));
        assert_eq!(s.lane_workspaces(&data, &LaneKey::from("bg")).len(), 1);

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
        s.move_to_lane(&data, Some(by_id(&data, "u")), LaneKey::from("bg"));
        s.move_to_lane(&data, Some(by_id(&data, "a")), LaneKey::from("bg"));
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
        s.move_to_lane(&data, Some(by_id(&data, "u")), LaneKey::from("bg"));
        data.epoch = Some(NOW + 60.0);
        s.move_to_lane(&data, Some(by_id(&data, "a")), LaneKey::from("bg"));
        let keys = param_of(&s, "workspace.group.create", "idempotency_key");
        assert_eq!(keys.len(), 2);
        assert_ne!(keys[0], keys[1]);
    }

    /// Adapted: dragging back is drop.ts's; it moves the card by move_to_lane to Unsorted.
    #[test]
    fn cancels_the_wait_when_the_card_is_dragged_back_to_unsorted() {
        let (mut s, mut data, _) = setup();
        s.move_to_lane(&data, Some(by_id(&data, "u")), LaneKey::from("bg"));
        s.move_to_lane(&data, Some(by_id(&data, "u")), LaneKey::unsorted());
        assert_eq!(s.lane_of(&data, by_id(&data, "u")), LaneKey::unsorted());
        s.take_outbox();
        add_bg_group(&mut data);
        s.card_workspaces(&data);
        assert!(calls(&s).is_empty());
    }

    #[test]
    fn hides_the_new_anchor_if_it_arrives_before_its_group() {
        let (mut s, mut data, _) = setup();
        s.move_to_lane(&data, Some(by_id(&data, "u")), LaneKey::from("bg"));
        if let Some(list) = data.workspaces.as_mut() {
            list.push(ws("anchor-bg").title("Background"));
        }
        assert!(!has(&ids(&s.card_workspaces(&data)), "anchor-bg"));
    }

    #[test]
    fn keeps_the_card_in_its_new_lane_past_the_usual_wait_while_the_group_is_made() {
        let (mut s, mut data, _) = setup();
        s.move_to_lane(&data, Some(by_id(&data, "u")), LaneKey::from("bg"));
        data.epoch = Some(NOW + 6.0);
        assert_eq!(s.lane_of(&data, by_id(&data, "u")), LaneKey::from("bg"));
    }

    #[test]
    fn lets_the_card_fall_back_if_the_group_never_arrives() {
        let (mut s, mut data, _) = setup();
        s.move_to_lane(&data, Some(by_id(&data, "u")), LaneKey::from("bg"));
        data.epoch = Some(NOW + 60.0);
        assert_eq!(s.lane_of(&data, by_id(&data, "u")), LaneKey::unsorted());
        s.take_outbox();
        add_bg_group(&mut data);
        s.card_workspaces(&data);
        assert!(calls(&s).is_empty());
    }

    /// Adapted: the drop is drop.ts's; a drop into a lane with no group moves the card by move_to_lane.
    #[test]
    fn files_a_dropped_card_into_a_lane_that_has_no_group_yet() {
        let (mut s, data, _) = setup();
        s.move_to_lane(&data, Some(by_id(&data, "u")), LaneKey::from("bg"));
        assert!(methods(&s).iter().any(|m| m == "workspace.group.create"));
        assert_eq!(s.lane_of(&data, by_id(&data, "u")), LaneKey::from("bg"));
    }
}

mod a_lanes_generated_anchor {
    use super::*;

    #[test]
    fn stays_off_the_cards_when_an_agent_runs_in_it_and_its_lane_counts_only_real_cards() {
        let (mut s, mut data, mut fx) = setup();
        ws_mut(&mut data, "anchor-review").agents = Some(vec![Some(fx.agent(Working))]);
        assert!(!has(&ids(&s.card_workspaces(&data)), "anchor-review"));
        assert_eq!(s.lane_workspaces(&data, &LaneKey::from("review")).len(), 1);
        assert!(!has(&entry_ids(&mut s, &data), "anchor-review@review"));
    }

    #[test]
    fn puts_its_status_on_the_lane_header_under_a_key_of_its_own() {
        let (mut s, mut data, mut fx) = setup();
        ws_mut(&mut data, "anchor-review").agents = Some(vec![Some(fx.agent(Working))]);
        assert_eq!(
            header(&mut s, &data, LaneKey::from("review")),
            Some(LaneEntry::Header {
                id: "h:review:anchor-review".into(),
                lane: LaneKey::from("review"),
                anchor_id: Some("anchor-review".into()),
            })
        );
    }

    #[test]
    fn leaves_the_header_plain_when_the_anchor_has_no_agent() {
        let (mut s, data, _) = setup();
        assert_eq!(
            header(&mut s, &data, LaneKey::from("review")),
            Some(LaneEntry::Header {
                id: "h:review".into(),
                lane: LaneKey::from("review"),
                anchor_id: None,
            })
        );
        assert!(!has(&ids(&s.card_workspaces(&data)), "anchor-review"));
    }

    #[test]
    fn keeps_a_real_workspace_used_as_an_anchor_as_a_card_with_or_without_an_agent() {
        let (mut s, _, mut fx) = setup();
        let mut data = frame(
            NOW,
            vec![group("g-bg", "Background").anchor("real")],
            vec![ws("real").title("Spike: wireless").group("g-bg")],
        );
        assert_eq!(ids(&s.card_workspaces(&data)), ["real"]);
        assert_eq!(
            header(&mut s, &data, LaneKey::from("bg")).map(|h| h.id().to_string()),
            Some("h:bg".to_string())
        );
        ws_mut(&mut data, "real").agents = Some(vec![Some(fx.agent(Working))]);
        assert_eq!(ids(&s.card_workspaces(&data)), ["real"]);
    }

    #[test]
    fn keeps_a_lane_whose_only_activity_is_its_anchors_agent_open_not_folded() {
        let (mut s, mut data, mut fx) = setup();
        if let Some(list) = data.workspaces.as_mut() {
            list.retain(|w| w.id != "c");
        }
        ws_mut(&mut data, "anchor-review").agents =
            Some(vec![Some(fx.agent(NeedsInput).since(1.0))]);
        let rows = entry_ids(&mut s, &data);
        assert!(has(&rows, "h:review:anchor-review"));
        assert!(!has(&rows, "z:review"));
        assert!(has(&rows, "z:bg"));
    }

    #[test]
    fn shows_on_the_header_for_unread_messages_alone_once_the_agent_has_gone() {
        let (mut s, mut data, _) = setup();
        ws_mut(&mut data, "anchor-review").unread = Some(3.0);
        assert_eq!(
            header(&mut s, &data, LaneKey::from("review")).map(|h| h.id().to_string()),
            Some("h:review:anchor-review".to_string())
        );
    }

    #[test]
    fn never_moves_out_of_the_group_it_anchors_even_from_the_card_menu() {
        let (mut s, data, _) = setup();
        let anchor = by_id(&data, "anchor-review");
        s.move_to_lane(&data, Some(anchor), LaneKey::from("parked"));
        assert!(calls(&s).is_empty());
        assert_eq!(s.lane_of(&data, anchor), LaneKey::from("review"));
    }

    #[test]
    fn still_lists_a_waiting_anchor_in_needs_you() {
        let (mut s, mut data, mut fx) = setup();
        ws_mut(&mut data, "anchor-review").agents =
            Some(vec![Some(fx.agent(NeedsInput).since(1.0))]);
        assert_eq!(ids(&s.needs_list(&data)), ["anchor-review"]);
    }
}

/// Issue #153: the Needs you header says how long the oldest ask has waited.
mod needs_you_clock {
    use super::*;

    /// Gives `id` an agent that has asked for `waited` seconds.
    fn ask(data: &mut Data, fx: &mut Fx, id: &str, waited: f64) {
        let since = now_epoch(data) - waited;
        ws_mut(data, id).agents = Some(vec![Some(fx.agent(NeedsInput).since(since))]);
    }

    #[test]
    fn is_blank_with_nothing_waiting_or_no_clock() {
        let (mut s, mut data, mut fx) = setup();
        assert_eq!(s.needs_wait_text(&data), "");
        assert!(!s.needs_wait_late(&data));
        ask(&mut data, &mut fx, "a", 45.0 * 60.0);
        data.epoch = Some(0.0);
        assert_eq!(s.needs_wait_text(&data), "");
        assert!(!s.needs_wait_late(&data));
    }

    #[test]
    fn skips_an_untimed_ask_rather_than_blanking_the_clock() {
        let (mut s, mut data, mut fx) = setup();
        ws_mut(&mut data, "b").agents = Some(vec![Some(fx.agent(NeedsInput))]);
        ask(&mut data, &mut fx, "a", 45.0 * 60.0);
        assert_eq!(
            s.needs_list(&data).first().map(|w| w.id.as_str()),
            Some("b")
        );
        assert_eq!(s.needs_wait_text(&data), "45m");
        assert!(s.needs_wait_late(&data));
    }

    #[test]
    fn times_the_oldest_ask_wherever_it_sits_in_the_data() {
        let (mut s, mut data, mut fx) = setup();
        ask(&mut data, &mut fx, "a", 5.0 * 60.0);
        ask(&mut data, &mut fx, "u", 12.0 * 60.0);
        ask(&mut data, &mut fx, "c", 60.0);
        assert_eq!(s.needs_wait_text(&data), "12m");
        assert!(!s.needs_wait_late(&data));
    }

    #[test]
    fn turns_late_at_30_minutes_not_before() {
        let (mut s, mut data, mut fx) = setup();
        ask(&mut data, &mut fx, "a", NEEDS_LATE_SECS - 1.0);
        assert_eq!(s.needs_wait_text(&data), "29m");
        assert!(!s.needs_wait_late(&data));
        ask(&mut data, &mut fx, "a", NEEDS_LATE_SECS);
        assert_eq!(s.needs_wait_text(&data), "30m");
        assert!(s.needs_wait_late(&data));
        ask(&mut data, &mut fx, "a", 3.0 * 3600.0);
        assert_eq!(s.needs_wait_text(&data), "3h");
        assert!(s.needs_wait_late(&data));
    }

    #[test]
    fn stops_counting_an_ask_once_it_is_dismissed() {
        let (mut s, mut data, mut fx) = setup();
        ask(&mut data, &mut fx, "a", 45.0 * 60.0);
        ask(&mut data, &mut fx, "b", 2.0 * 60.0);
        s.dismiss_needs(Some(by_id(&data, "a")));
        assert_eq!(s.needs_wait_text(&data), "2m");
        assert!(!s.needs_wait_late(&data));
    }
}

/// Issue #50: an empty lane is a drop box in its own place, whether or not
/// a card is being dragged.
mod empty_lanes {
    use super::*;

    fn drop_empty(data: &mut Data) {
        if let Some(list) = data.workspaces.as_mut() {
            list.retain(|w| w.id != "c");
        }
    }

    fn headers_and_zones(s: &mut Session, data: &Data) -> Vec<String> {
        entry_ids(s, data)
            .into_iter()
            .filter(|id| id.starts_with("z:") || id.starts_with("h:"))
            .collect()
    }

    #[test]
    fn lose_their_headers_for_a_zone_each_in_lane_order_and_in_the_lanes_own_place() {
        let (mut s, mut data, _) = setup();
        drop_empty(&mut data);
        let rows = entry_ids(&mut s, &data);
        assert!(!has(&rows, "h:review"));
        assert!(!has(&rows, "h:bg"));
        assert_eq!(
            headers_and_zones(&mut s, &data),
            ["h:main", "z:review", "z:bg", "h:parked", "h:unsorted"]
        );
    }

    #[test]
    fn have_no_zone_once_every_lane_has_a_card_and_no_empty_line_at_all() {
        let (mut s, mut data, _) = setup();
        data.workspaces
            .get_or_insert_with(Vec::new)
            .push(ws("d").group("g-bg"));
        data.groups
            .get_or_insert_with(Vec::new)
            .push(group("g-bg", "Background").anchor("anchor-bg"));
        assert!(
            !entry_ids(&mut s, &data)
                .iter()
                .any(|id| id.starts_with("z:") || id.starts_with("f:"))
        );
    }

    #[test]
    fn keep_the_same_rows_as_a_drag_starts_and_ends_so_the_drop_index_never_shifts() {
        let (mut s, data, _) = setup();
        let rest = entry_ids(&mut s, &data);
        s.set_drag(Some(DragState {
            id: "w:a".into(),
            index: 1.0,
        }));
        assert_eq!(entry_ids(&mut s, &data), rest);
        s.set_drag(None);
        assert_eq!(entry_ids(&mut s, &data), rest);
    }

    /// Adapted: the TypeScript drops c onto Background's zone (drop.ts);
    /// here `move_to_lane` makes the lane change that drop makes.
    #[test]
    fn keep_their_zone_after_a_drop_empties_a_lane_with_no_drag_running() {
        let (mut s, data, _) = setup();
        s.move_to_lane(&data, Some(by_id(&data, "c")), LaneKey::from("bg"));
        assert_eq!(s.lane_of(&data, by_id(&data, "c")), LaneKey::from("bg"));
        assert_eq!(
            headers_and_zones(&mut s, &data),
            ["h:main", "z:review", "h:bg", "h:parked", "h:unsorted"]
        );
    }
}

mod needs_you {
    use super::*;

    /// The Main activity rows: its cards.
    fn main_rows(s: &mut Session, data: &Data) -> Vec<String> {
        entry_ids(s, data)
            .into_iter()
            .filter(|id| id.ends_with("@main"))
            .collect()
    }

    #[test]
    fn a_dismissal_holds_until_the_agent_asks_again() {
        let (mut s, mut data, mut fx) = setup();
        ws_mut(&mut data, "a").agents = Some(vec![Some(fx.agent(NeedsInput).since(500.0))]);
        s.dismiss_needs(Some(by_id(&data, "a")));
        assert_eq!(s.status_of(Some(by_id(&data, "a"))), Status::Idle);
        ws_mut(&mut data, "a").agents = Some(vec![Some(fx.agent(NeedsInput).since(900.0))]);
        assert_eq!(s.status_of(Some(by_id(&data, "a"))), Status::NeedsInput);
    }

    #[test]
    fn lists_waiting_workspaces_longest_waiting_first() {
        let (mut s, mut data, mut fx) = setup();
        ws_mut(&mut data, "a").agents = Some(vec![Some(fx.agent(NeedsInput).since(200.0))]);
        ws_mut(&mut data, "c").agents = Some(vec![Some(fx.agent(NeedsInput).since(100.0))]);
        assert_eq!(ids(&s.needs_list(&data)), ["c", "a"]);
    }

    /// Adapted for R4.5 (issue #281): the TypeScript leaves a placeholder
    /// where a listed card was; the core keeps the card itself there.
    #[test]
    fn keeps_a_listed_card_in_its_place_counted_and_still_there_once_dismissed() {
        let (mut s, mut data, mut fx) = setup();
        ws_mut(&mut data, "a").agents = Some(vec![Some(fx.agent(NeedsInput).since(500.0))]);
        let rows = entry_ids(&mut s, &data);
        assert!(has(&rows, "a@main"));
        assert!(!rows.iter().any(|id| id.starts_with("g:")));
        assert_eq!(
            ids(&s.lane_workspaces(&data, &LaneKey::from("main"))),
            ["a", "b"]
        );
        let at = position(&rows, "a@main");
        s.dismiss_needs(Some(by_id(&data, "a")));
        assert!(!has(&ids(&s.needs_list(&data)), "a"));
        let rows = entry_ids(&mut s, &data);
        assert_eq!(position(&rows, "a@main"), at);
        assert_eq!(s.lane_workspaces(&data, &LaneKey::from("main")).len(), 2);
    }

    /// Issue #314: cards never leave their lane, so a dismissed card is
    /// held nowhere; it sorts by the status it now reads.
    #[test]
    fn sorts_a_dismissed_card_by_the_status_it_now_reads_at_once() {
        let (mut s, mut data, mut fx) = setup();
        ws_mut(&mut data, "b").agents = Some(vec![Some(fx.agent(Working).since(400.0))]);
        ws_mut(&mut data, "a").agents = Some(vec![Some(fx.agent(NeedsInput).since(500.0))]);
        assert_eq!(main_rows(&mut s, &data), ["a@main", "b@main"]);
        s.dismiss_needs(Some(by_id(&data, "a")));
        // Idle now, under the working card.
        assert_eq!(main_rows(&mut s, &data), ["b@main", "a@main"]);
        assert_eq!(s.state_rank(&data, Some(by_id(&data, "a"))), 3);
    }

    #[test]
    fn leaves_a_card_that_is_not_waiting_where_it_sorts_when_the_menu_dismisses_it() {
        let (mut s, mut data, mut fx) = setup();
        ws_mut(&mut data, "b").agents = Some(vec![Some(fx.agent(Working).since(400.0))]);
        s.dismiss_needs(Some(by_id(&data, "a")));
        let main: Vec<String> = entry_ids(&mut s, &data)
            .into_iter()
            .filter(|id| id.ends_with("@main"))
            .collect();
        assert_eq!(main, ["b@main", "a@main"]);
        assert!(s.outbox().is_empty(), "nothing to dismiss, nothing saved");
    }

    #[test]
    fn tops_its_lane_again_when_a_dismissed_agent_asks_again_then_sorts_by_status() {
        let (mut s, mut data, mut fx) = setup();
        ws_mut(&mut data, "b").agents = Some(vec![Some(fx.agent(Working).since(400.0))]);
        ws_mut(&mut data, "a").agents = Some(vec![Some(fx.agent(NeedsInput).since(500.0))]);
        s.dismiss_needs(Some(by_id(&data, "a")));
        ws_mut(&mut data, "a").agents = Some(vec![Some(fx.agent(NeedsInput).since(900.0))]);
        assert_eq!(s.state_rank(&data, Some(by_id(&data, "a"))), 0);
        ws_mut(&mut data, "a").agents = Some(vec![Some(fx.agent(Idle).since(950.0))]);
        assert_eq!(s.state_rank(&data, Some(by_id(&data, "a"))), 3);
    }

    #[test]
    fn names_the_lane_for_a_waiting_generated_anchor_even_in_projects_view() {
        let (mut s, data, _) = setup();
        s.set_mode(ViewMode::Projects);
        let origin = s.origin_of(&data, Some(by_id(&data, "anchor-main")));
        assert_eq!(origin.name, "Main activity");
    }

    #[test]
    fn keeps_a_lane_whose_only_card_waits_with_the_card_under_its_header() {
        let (mut s, mut data, mut fx) = setup();
        ws_mut(&mut data, "c").agents = Some(vec![Some(fx.agent(NeedsInput).since(500.0))]);
        let rows = entry_ids(&mut s, &data);
        assert!(!has(&rows, "z:review"));
        let at = rows.iter().position(|id| id.starts_with("h:review"));
        assert_eq!(
            at.and_then(|i| rows.get(i + 1)).map(String::as_str),
            Some("c@review")
        );
    }

    #[test]
    fn hides_a_folded_lanes_waiting_card_but_still_counts_it() {
        let (mut s, mut data, mut fx) = setup();
        ws_mut(&mut data, "c").agents = Some(vec![Some(fx.agent(NeedsInput).since(500.0))]);
        let review = lane_by_key(LaneKey::from("review"));
        if !s.is_collapsed(&data, &review) {
            s.toggle_lane(&data, &review.key);
        }
        assert!(!has(&entry_ids(&mut s, &data), "c@review"));
        assert!(has(&ids(&s.needs_list(&data)), "c"));
        assert_eq!(s.lane_workspaces(&data, &LaneKey::from("review")).len(), 1);
    }

    #[test]
    fn names_the_lane_a_waiting_session_came_from_or_its_project_group_in_projects_view() {
        let (mut s, mut data, _) = setup();
        ws_mut(&mut data, "a").directory = Some("/Users/coder/dev/app-two".into());
        assert_eq!(
            s.origin_of(&data, Some(by_id(&data, "a"))),
            Origin {
                name: "Main activity".into(),
                color: Colour::Token(Token::LaneMain),
            }
        );
        s.set_mode(ViewMode::Projects);
        assert_eq!(s.origin_of(&data, Some(by_id(&data, "a"))).name, "App Two");
        assert_eq!(s.origin_of(&data, None).name, "");
    }

    #[test]
    fn keeps_a_card_in_its_lane_when_it_starts_asking_dragged_or_not() {
        let (mut s, mut data, mut fx) = setup();
        s.set_drag(Some(DragState {
            id: "w:a".into(),
            index: 1.0,
        }));
        ws_mut(&mut data, "a").agents = Some(vec![Some(fx.agent(NeedsInput).since(500.0))]);
        assert!(has(&ids(&s.needs_list(&data)), "a"));
        assert!(has(&entry_ids(&mut s, &data), "a@main"));
        s.set_drag(None);
        assert!(
            has(&entry_ids(&mut s, &data), "a@main"),
            "no placeholder: the card stays (issue #281)"
        );
    }

    /// Adapted for R4.5 (issue #281): the TypeScript leaves a placeholder
    /// in the project; the core keeps the card itself under its header.
    #[test]
    fn keeps_a_card_it_lists_in_its_project_under_its_header() {
        let (mut s, mut data, mut fx) = setup();
        ws_mut(&mut data, "a").directory = Some("/Users/coder/dev/app-two".into());
        ws_mut(&mut data, "c").directory = Some("/Users/coder/dev/app-one".into());
        ws_mut(&mut data, "a").agents = Some(vec![Some(fx.agent(NeedsInput).since(500.0))]);
        s.set_mode(ViewMode::Projects);
        assert!(has(&ids(&s.needs_list(&data)), "a"));
        // Its header stays over the card, counting it, so its "+" is still
        // there; not quiet, as it has a session.
        let rows = project_ids(&mut s, &data);
        assert_eq!(after(&rows, "p:/dev/app-two").as_deref(), Some("a@p"));
        assert!(!has(&rows, "q:/dev/app-two"));
        assert_eq!(s.project_workspaces(&data, "/dev/app-two").len(), 1);
        // An editor open on it stays open.
        s.set_editing_project(Some("/dev/app-two"));
        assert!(has(&project_ids(&mut s, &data), "e:/dev/app-two"));
        s.set_editing_project(None);
        ws_mut(&mut data, "a").agents = Some(vec![Some(fx.agent(Working).since(500.0))]);
        let rows = project_ids(&mut s, &data);
        assert!(has(&rows, "p:/dev/app-two"));
        assert!(has(&rows, "a@p"));
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

    #[test]
    fn regroups_project_entries_by_the_override_not_the_path() {
        let (mut s, mut data, _) = setup();
        ws_mut(&mut data, "a").directory = Some("/Users/coder/dev/app-one".into());
        s.move_to_project(Some(by_id(&data, "a")), "/dev/app-two");
        s.set_mode(ViewMode::Projects);
        let rows = project_ids(&mut s, &data);
        assert_eq!(after(&rows, "p:/dev/app-two").as_deref(), Some("a@p"));
        // a moved out of app-one, so app-one has no header and joins the quiet rows.
        assert!(!has(&rows, "p:/dev/app-one"));
        assert!(has(&s.quiet_projects(&data), "/dev/app-one"));
    }

    #[test]
    fn offers_plus_only_for_a_project_with_a_root_and_opens_a_workspace_there() {
        let (mut s, data, _) = setup();
        // The example table gives App One a root; App Two and Other have none.
        assert!(s.can_open_project("/dev/app-one"));
        assert!(!s.can_open_project("/dev/app-two"));
        assert!(!s.can_open_project("other"));
        s.open_project_workspace(&data, "/dev/app-one", None);
        assert_eq!(
            calls(&s),
            [call(
                "workspace.create",
                &[("cwd", "~/dev/app-one"), ("focus", "true")]
            )]
        );
    }

    #[test]
    fn does_nothing_when_the_project_has_no_root() {
        let (mut s, data, _) = setup();
        s.open_project_workspace(&data, "/dev/app-two", None);
        assert!(calls(&s).is_empty());
    }

    #[test]
    fn labels_the_card_menus_new_session_by_project_or_says_why_it_cannot() {
        let (mut s, data, _) = setup();
        let one = ws("one").directory("/Users/coder/dev/app-one");
        let two = ws("two").directory("/Users/coder/dev/app-two");
        assert_eq!(s.new_session_label(Some(&one)), "New session in App One");
        assert_eq!(
            s.new_session_label(Some(&two)),
            "New session (project has no folder)"
        );
        assert_eq!(
            s.new_session_label(Some(by_id(&data, "u"))),
            "New session (project has no folder)"
        );
        assert_eq!(s.new_session_label(None), "New session (no workspace)");
        s.new_session_for(&data, Some(&two));
        s.new_session_for(&data, None);
        assert!(calls(&s).is_empty());
        s.new_session_for(&data, Some(&one));
        assert_eq!(
            calls(&s),
            [call(
                "workspace.create",
                &[
                    ("cwd", "~/dev/app-one"),
                    ("focus", "true"),
                    ("group_id", "g-main"),
                    ("group_placement", "top")
                ]
            )]
        );
        let menu = card_menu(&mut s, &data, Some(&one));
        assert_eq!(
            menu.first().map(String::as_str),
            Some("button:New session in App One")
        );
    }
}

// cmux drops submenus from a context menu, so every item must sit at the
// top level (issue #8's "Move to project" never showed).
mod card_menu {
    use super::*;

    #[test]
    fn offers_every_lane_and_project_at_the_top_level_ticking_the_current_ones() {
        let (mut s, data, _) = setup();
        s.clear_project_override(Some(by_id(&data, "a")));
        let menu = card_menu(&mut s, &data, Some(by_id(&data, "a")));
        assert!(has(&menu, "button:✓ Lane: Main activity"));
        for lane in Lanes::default()
            .iter()
            .filter(|l| l.key != LaneKey::from("main"))
        {
            assert!(has(&menu, &format!("button:Lane: {}", lane.name)));
        }
        for p in example_projects() {
            assert!(has(&menu, &format!("button:Project: {}", p.name)));
        }
        // "a" has no directory, so it falls in Other: only its lane is ticked.
        let ticked: Vec<&String> = menu.iter().filter(|m| m.starts_with("button:✓ ")).collect();
        assert_eq!(ticked, ["button:✓ Lane: Main activity"]);
        assert!(has(&menu, "button:No project override set"));
    }

    #[test]
    fn offers_to_clear_an_override_once_one_is_set() {
        let (mut s, data, _) = setup();
        let first = example_projects()[0].clone();
        s.move_to_project(Some(by_id(&data, "a")), first.id());
        let menu = card_menu(&mut s, &data, Some(by_id(&data, "a")));
        assert!(has(&menu, &format!("button:✓ Project: {}", first.name)));
        assert!(has(&menu, "button:Clear project override"));
        s.clear_project_override(Some(by_id(&data, "a")));
        let menu = card_menu(&mut s, &data, Some(by_id(&data, "a")));
        assert!(has(&menu, "button:No project override set"));
        assert!(!menu.iter().any(|m| m.starts_with("button:✓ Project:")));
    }
}

mod lane_markers {
    use super::*;

    #[test]
    fn are_all_distinct() {
        let lanes = Lanes::default();
        let colors: std::collections::HashSet<_> = lanes.iter().map(|l| l.color).collect();
        assert_eq!(colors.len(), lanes.iter().count());
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
        s.toggle_lane(&data, &LaneKey::unsorted());
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
        s.toggle_lane(&data, &LaneKey::unsorted());
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
        let parked = lane_by_key(LaneKey::from("parked"));
        if s.is_collapsed(&data, &parked) {
            s.toggle_lane(&data, &parked.key);
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

    // Not ported: PR #280's review, findings 2 and 3.

    #[test]
    fn holds_while_cmux_still_shows_the_selection_from_before_the_tap() {
        let (mut s, mut data, _) = setup();
        data.selected_id = Some("other".into());
        s.select_workspace(&data, Some("tapped"));
        data.epoch = Some(NOW + 2.0);
        assert!(s.is_selected(&data, Some(&ws("tapped"))));
        assert!(!s.is_selected(&data, Some(&ws("other").selected())));
    }

    #[test]
    fn gives_way_at_once_when_cmux_refuses_the_select() {
        let (mut s, mut data, _) = setup();
        data.selected_id = Some("other".into());
        s.select_workspace(&data, Some("tapped"));
        s.request_failed("tapped");
        assert!(!s.is_selected(&data, Some(&ws("tapped"))));
        assert!(s.is_selected(&data, Some(&ws("other").selected())));
    }

    #[test]
    fn holds_through_a_failed_call_about_another_workspace() {
        let (mut s, mut data, _) = setup();
        data.selected_id = Some("other".into());
        s.select_workspace(&data, Some("tapped"));
        s.request_failed("a");
        assert!(s.is_selected(&data, Some(&ws("tapped"))));
    }

    #[test]
    fn gives_way_when_cmux_publishes_a_different_selection() {
        let (mut s, mut data, _) = setup();
        data.selected_id = Some("other".into());
        s.select_workspace(&data, Some("tapped"));
        data.epoch = Some(NOW + 1.0);
        data.selected_id = Some("third".into());
        assert!(!s.is_selected(&data, Some(&ws("tapped"))));
        assert!(s.is_selected(&data, Some(&ws("third").selected())));
        // Gone, not hidden: cmux going back to the old selection within the
        // window shows that one, not the tap.
        data.selected_id = Some("other".into());
        assert!(!s.is_selected(&data, Some(&ws("tapped"))));
    }

    #[test]
    fn holds_through_a_frame_that_leaves_the_selection_out() {
        let (mut s, mut data, _) = setup();
        data.selected_id = Some("other".into());
        s.select_workspace(&data, Some("tapped"));
        data.selected_id = None;
        assert!(s.is_selected(&data, Some(&ws("tapped"))));
    }

    #[test]
    fn a_second_tap_holds_through_cmux_publishing_the_first() {
        let (mut s, mut data, _) = setup();
        data.selected_id = Some("other".into());
        s.select_workspace(&data, Some("first"));
        s.select_workspace(&data, Some("second"));
        data.epoch = Some(NOW + 1.0);
        data.selected_id = Some("first".into());
        assert!(s.is_selected(&data, Some(&ws("second"))));
        assert!(!s.is_selected(&data, Some(&ws("first").selected())));
    }

    #[test]
    fn holds_when_the_tap_frame_marked_the_old_selection_only_on_its_card() {
        let (mut s, mut data, _) = setup();
        if let Some(list) = data.workspaces.as_mut() {
            for w in list.iter_mut().filter(|w| w.id == "a") {
                w.selected = Some(true);
            }
        }
        s.select_workspace(&data, Some("tapped"));
        data.epoch = Some(NOW + 1.0);
        data.selected_id = Some("a".into());
        assert!(s.is_selected(&data, Some(&ws("tapped"))));
    }

    #[test]
    fn a_lapsed_tap_is_not_carried_into_the_next() {
        let (mut s, mut data, _) = setup();
        data.selected_id = Some("other".into());
        s.select_workspace(&data, Some("first"));
        data.epoch = Some(NOW + 5.0);
        s.select_workspace(&data, Some("second"));
        data.epoch = Some(NOW + 6.0);
        data.selected_id = Some("first".into());
        assert!(!s.is_selected(&data, Some(&ws("second"))));
        assert!(s.is_selected(&data, Some(&ws("first").selected())));
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
        assert!(!s.lane_anchor_ids(&data).contains("real"));
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

mod projects_mode {
    use super::*;

    #[test]
    fn groups_by_project_in_projects_order_then_other_with_the_quiet_rows_last() {
        let (mut s, mut data, _) = setup();
        ws_mut(&mut data, "a").directory = Some("/Users/coder/dev/app-two".into());
        ws_mut(&mut data, "c").directory = Some("/Users/coder/dev/app-one".into());
        s.set_mode(ViewMode::Projects);
        assert_eq!(
            project_ids(&mut s, &data),
            [
                "p:/dev/app-one",
                "c@p",
                "p:/dev/app-two",
                "a@p",
                // app-three has no sessions: no header, it waits under Quiet.
                "p:other",
                "b@p",
                "p@p",
                "u@p",
                // "+ New project", above the quiet ones.
                "new",
                "quiet",
                "q:/dev/app-three",
            ]
        );
    }

    #[test]
    fn keeps_a_project_with_several_matches_in_one_group_keyed_by_its_first_match() {
        let (mut s, mut data, _) = setup();
        ws_mut(&mut data, "a").directory = Some("/Users/coder/dev/app-two/src".into());
        ws_mut(&mut data, "b").directory = Some("/Users/coder/.config/app-two".into());
        s.set_mode(ViewMode::Projects);
        let entries = s.project_entries(&data);
        let headers = entries
            .iter()
            .filter(
                |e| matches!(e, ProjectEntry::Header { project, .. } if project == "/dev/app-two"),
            )
            .count();
        assert_eq!(headers, 1);
        let rows: Vec<String> = entries.iter().map(|e| e.id().to_string()).collect();
        let at = position(&rows, "p:/dev/app-two").unwrap();
        assert_eq!(rows[at..at + 3], ["p:/dev/app-two", "a@p", "b@p"]);
        assert_eq!(s.project_workspaces(&data, "/dev/app-two").len(), 2);
        assert_eq!(s.project_by_key("/dev/app-two").name, "App Two");
    }

    #[test]
    fn collapses_a_multi_match_project_as_one_group() {
        let (mut s, mut data, _) = setup();
        ws_mut(&mut data, "a").directory = Some("/Users/coder/dev/app-two".into());
        ws_mut(&mut data, "b").directory = Some("/Users/coder/.config/app-two".into());
        s.set_mode(ViewMode::Projects);
        s.toggle_project(&data, "/dev/app-two");
        let rows = project_ids(&mut s, &data);
        assert!(!has(&rows, "a@p"));
        assert!(!has(&rows, "b@p"));
        assert_eq!(after(&rows, "p:/dev/app-two").as_deref(), Some("p:other"));
    }

    #[test]
    fn puts_projects_with_no_sessions_under_one_quiet_header_a_row_each_in_table_order_issue_54() {
        let (mut s, data, _) = setup();
        s.set_mode(ViewMode::Projects);
        // No fixture directory matches a project, so all three are quiet.
        assert_eq!(
            s.quiet_projects(&data),
            ["/dev/app-one", "/dev/app-two", "/dev/app-three"]
        );
        let entries = s.project_entries(&data);
        assert!(
            !entries
                .iter()
                .any(|e| matches!(e, ProjectEntry::Header { project, .. } if project != "other"))
        );
        let quiet_headers = entries
            .iter()
            .filter(|e| matches!(e, ProjectEntry::QuietHeader { .. }))
            .count();
        assert_eq!(quiet_headers, 1);
        let quiet_row = |k: &str| ProjectEntry::QuietRow {
            id: format!("q:{k}"),
            project: k.to_string(),
        };
        assert_eq!(
            entries[entries.len() - 4..],
            [
                ProjectEntry::QuietHeader { id: "quiet".into() },
                quiet_row("/dev/app-one"),
                quiet_row("/dev/app-two"),
                quiet_row("/dev/app-three"),
            ]
        );
    }

    #[test]
    fn folds_the_quiet_rows_under_their_header_and_unfolds_them_again() {
        let (mut s, data, _) = setup();
        s.set_mode(ViewMode::Projects);
        assert!(!s.quiet_collapsed());
        s.toggle_quiet(&data);
        assert!(s.quiet_collapsed());
        let rows = project_ids(&mut s, &data);
        assert_eq!(rows.last().map(String::as_str), Some("quiet"));
        assert!(!rows.iter().any(|id| id.starts_with("q:")));
        // The fold does not touch a project's own fold.
        assert!(!s.is_project_collapsed("/dev/app-one"));
        s.toggle_quiet(&data);
        let rows = project_ids(&mut s, &data);
        assert_eq!(rows.last().map(String::as_str), Some("q:/dev/app-three"));
    }

    #[test]
    fn drops_the_quiet_header_once_every_project_has_a_session() {
        let (mut s, mut data, _) = setup();
        ws_mut(&mut data, "a").directory = Some("/Users/coder/dev/app-one".into());
        ws_mut(&mut data, "b").directory = Some("/Users/coder/dev/app-two".into());
        ws_mut(&mut data, "c").directory = Some("/Users/coder/dev/app-three".into());
        s.set_mode(ViewMode::Projects);
        assert!(s.quiet_projects(&data).is_empty());
        assert!(!s.project_entries(&data).iter().any(|e| matches!(
            e,
            ProjectEntry::QuietHeader { .. } | ProjectEntry::QuietRow { .. }
        )));
    }

    #[test]
    fn keeps_a_folded_project_with_no_sessions_as_a_quiet_row_not_a_header() {
        let (mut s, mut data, _) = setup();
        ws_mut(&mut data, "a").directory = Some("/Users/coder/dev/app-one".into());
        s.set_mode(ViewMode::Projects);
        s.toggle_project(&data, "/dev/app-three");
        let rows = project_ids(&mut s, &data);
        assert!(!has(&rows, "p:/dev/app-three"));
        assert!(has(&rows, "q:/dev/app-three"));
        assert_eq!(s.quiet_projects(&data), ["/dev/app-two", "/dev/app-three"]);
    }

    #[test]
    fn labels_a_quiet_row_by_what_a_tap_does_or_why_it_does_nothing() {
        let (mut s, data, _) = setup();
        // The example table gives App One a root; App Two has none.
        assert_eq!(s.quiet_label("/dev/app-one"), "New session in App One");
        assert_eq!(
            s.quiet_label("/dev/app-two"),
            "App Two has no folder to open"
        );
        s.open_project_workspace(&data, "/dev/app-two", None);
        assert!(calls(&s).is_empty());
        s.open_project_workspace(&data, "/dev/app-one", None);
        assert_eq!(
            calls(&s),
            [call(
                "workspace.create",
                &[("cwd", "~/dev/app-one"), ("focus", "true")]
            )]
        );
    }

    #[test]
    fn unfolds_a_folded_quiet_project_when_a_session_opens_there_so_the_new_card_shows() {
        let (mut s, mut data, _) = setup();
        s.set_mode(ViewMode::Projects);
        s.toggle_project(&data, "/dev/app-one");
        assert!(s.is_project_collapsed("/dev/app-one"));
        s.open_project_workspace(&data, "/dev/app-one", None);
        assert!(!s.is_project_collapsed("/dev/app-one"));
        ws_mut(&mut data, "a").directory = Some("/Users/coder/dev/app-one".into());
        let rows = project_ids(&mut s, &data);
        assert_eq!(after(&rows, "p:/dev/app-one").as_deref(), Some("a@p"));
    }

    #[test]
    fn never_shows_other_as_a_header_when_nothing_falls_into_it() {
        let (mut s, mut data, _) = setup();
        for w in data.workspaces.iter_mut().flatten() {
            w.directory = Some("/Users/coder/dev/app-one".into());
        }
        s.set_mode(ViewMode::Projects);
        assert!(
            !s.project_entries(&data)
                .iter()
                .any(|e| matches!(e, ProjectEntry::Header { project, .. } if project == "other"))
        );
    }
}

mod new_session_from_a_card {
    use super::*;

    fn one() -> Workspace {
        ws("one").directory("/Users/coder/dev/app-one")
    }

    /// Main activity's group folded, as cmux has it.
    fn main_folded(data: &mut Data) {
        for g in data.groups.iter_mut().flatten() {
            if g.name.as_deref() == Some("Main activity") {
                g.collapsed = Some(true);
            }
        }
    }

    #[test]
    fn opens_ungrouped_while_there_is_no_main_activity_group() {
        let (mut s, mut data, _) = setup();
        if let Some(groups) = data.groups.as_mut() {
            groups.retain(|g: &WorkspaceGroup| g.name.as_deref() != Some("Main activity"));
        }
        s.new_session_for(&data, Some(&one()));
        assert_eq!(
            calls(&s),
            [call(
                "workspace.create",
                &[("cwd", "~/dev/app-one"), ("focus", "true")]
            )]
        );
    }

    #[test]
    fn unfolds_a_folded_main_activity_first_so_the_new_card_is_not_hidden() {
        let (mut s, mut data, _) = setup();
        main_folded(&mut data);
        s.new_session_for(&data, Some(&one()));
        assert_eq!(methods(&s), ["workspace.group.expand", "workspace.create"]);
        assert_eq!(
            calls(&s).first().map(|(_, p)| p.clone()),
            Some(vec![("group_id".to_string(), "g-main".to_string())])
        );
        assert!(!s.is_collapsed(&data, &lane_by_key(LaneKey::from("main"))));
    }

    #[test]
    fn leaves_the_lanes_alone_when_the_project_has_no_folder() {
        let (mut s, mut data, _) = setup();
        main_folded(&mut data);
        let two = ws("two").directory("/Users/coder/dev/app-two");
        s.new_session_for(&data, Some(&two));
        assert!(calls(&s).is_empty());
    }

    #[test]
    fn leaves_the_project_headers_plus_ungrouped() {
        let (mut s, data, _) = setup();
        s.open_project_workspace(&data, "/dev/app-one", None);
        assert_eq!(
            calls(&s),
            [call(
                "workspace.create",
                &[("cwd", "~/dev/app-one"), ("focus", "true")]
            )]
        );
    }
}

mod pr_text_color {
    use super::*;
    use cockpit_core::data::PrStatus;
    use cockpit_core::pr_colors::{READY_INK, pr_text_color};
    use cockpit_core::prs::{PrHealth, PrSummary};

    /// The density's own colour, as the TypeScript's "#111111".
    const QUIET: Token = Token::Faint;

    fn pr(health: PrHealth, status: PrStatus) -> PrSummary {
        PrSummary {
            number: 1.0,
            status: Some(status),
            url: None,
            health,
            tag: "#1".into(),
            text: "#1".into(),
            state: String::new(),
            title: String::new(),
            diff: String::new(),
        }
    }

    #[test]
    fn keeps_the_densitys_colour_while_the_pr_is_quiet_or_absent() {
        assert_eq!(pr_text_color(None, QUIET), QUIET);
        let quiet = pr(PrHealth::Quiet, PrStatus::Open);
        assert_eq!(pr_text_color(Some(&quiet), QUIET), QUIET);
        let merged = pr(PrHealth::Quiet, PrStatus::Merged);
        assert_eq!(pr_text_color(Some(&merged), QUIET), QUIET);
    }

    #[test]
    fn takes_the_healths_chip_colour_otherwise_running_in_blue() {
        let failing = pr(PrHealth::Failing, PrStatus::Open);
        assert_eq!(pr_text_color(Some(&failing), QUIET), Token::RedText);
        let running = pr(PrHealth::Running, PrStatus::Open);
        assert_eq!(pr_text_color(Some(&running), QUIET), Token::BlueText);
        let ready = pr(PrHealth::Ready, PrStatus::Open);
        assert_eq!(pr_text_color(Some(&ready), QUIET), READY_INK);
    }
}

mod new_project_from_a_card_issue_9 {
    use super::*;

    /// The value of the state write at `i`, as JSON.
    fn value_at(s: &Session, i: usize) -> Value {
        sent(s)
            .get(i)
            .and_then(|(_, v)| v.clone())
            .unwrap_or(Value::Null)
    }

    #[test]
    fn offers_it_on_a_card_whose_folder_matches_no_project_and_sends_the_new_project() {
        let (mut s, mut data, _) = setup();
        let loose = ws("loose")
            .group("g-main")
            .directory("/Users/jon/dev/scratch");
        data.workspaces.get_or_insert_with(Vec::new).push(loose);
        let loose = by_id(&data, "loose");
        let menu = card_menu(&mut s, &data, Some(loose));
        assert!(has(&menu, "button:New project from this folder"));
        s.create_project_from(Some(loose));
        assert_eq!(
            sent(&s).first().map(|(k, _)| k.as_str()),
            Some("projects./users/jon/dev/scratch/")
        );
        // Waiting on the rebuild: a second tap must not resend it under "Scratch 2".
        assert!(!s.can_create_project(Some(loose)));
        s.create_project_from(Some(loose));
        assert_eq!(sent(&s).len(), 1);
        assert_eq!(value_at(&s, 0)["name"], "Scratch");
    }

    #[test]
    fn counts_a_project_sent_but_not_built_yet_so_a_second_folder_gets_a_fresh_name_and_colour() {
        let (mut s, _, _) = setup();
        s.create_project_from(Some(&ws("one").directory("/a/app")));
        s.create_project_from(Some(&ws("two").directory("/b/app")));
        let (a, b) = (value_at(&s, 0), value_at(&s, 1));
        assert_eq!(a["name"], "App");
        assert_eq!(b["name"], "App 2");
        assert_ne!(a["color"], b["color"]);
    }

    #[test]
    fn is_not_offered_to_a_card_moved_into_a_project_by_hand() {
        let (mut s, mut data, _) = setup();
        let first = example_projects()[0].id().to_string();
        let moved = ws("moved").directory("/Users/jon/dev/elsewhere");
        data.workspaces.get_or_insert_with(Vec::new).push(moved);
        let moved = by_id(&data, "moved");
        s.move_to_project(Some(moved), &first);
        assert!(!s.can_create_project(Some(moved)));
        s.clear_project_override(Some(moved));
        assert!(s.can_create_project(Some(moved)));
    }

    #[test]
    fn does_nothing_for_a_card_already_in_a_project_or_with_no_folder() {
        let (mut s, data, _) = setup();
        let first = example_projects()[0].id().to_string();
        let matched = ws("matched").directory(&format!("/Users/jon{first}"));
        let no_folder = ws("nofolder");
        for w in [Some(&matched), Some(&no_folder), None] {
            assert!(!s.can_create_project(w));
            s.create_project_from(w);
        }
        assert!(opened(&s).is_empty());
        let menu = card_menu(&mut s, &data, Some(&matched));
        assert!(has(&menu, "button:New project (folder has one, or none)"));
    }
}
