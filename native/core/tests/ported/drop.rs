//! test/cockpit.test.ts's resolveDrop and handleMove cases (drop.ts), on
//! the same fixture as cockpit.rs. The drag-state cases that read the
//! view's drop lane (handleDragChange, dropLane) are left for the views.

use cockpit_core::data::Data;
use cockpit_core::lane_entries::LaneEntry;
use cockpit_core::lanes::LaneKey;
use cockpit_core::persist::ViewMode;
use cockpit_core::placement::{DropTarget, is_foreign_anchor};
use cockpit_core::session::Session;
use cockpit_core::state::DragState;

use crate::support::*;

const NOW: f64 = 1_000_100.0;

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

fn ids(s: &mut Session, data: &Data) -> Vec<String> {
    s.lane_entries(data)
        .into_iter()
        .map(|e| match e {
            LaneEntry::Ws { ws_id, lane, .. } => format!("{ws_id}@{}", lane.as_str()),
            other => other.id().to_string(),
        })
        .collect()
}

fn target(lane: LaneKey, next: Option<&str>, prev: Option<&str>) -> DropTarget {
    DropTarget {
        lane,
        next_ref: next.map(str::to_string),
        prev_ref: prev.map(str::to_string),
    }
}

mod resolve_drop {
    use super::*;

    #[test]
    fn takes_the_lane_of_the_row_above_the_slot() {
        let (mut s, data, _) = setup();
        // Without a@main: [h:main, b@main, h:review, c@review, ...]; slot 3 is under h:review.
        assert_eq!(
            s.resolve_drop(&data, "w:a", 3),
            target(LaneKey::Review, Some("c"), None)
        );
    }

    #[test]
    fn files_a_drop_at_the_very_top_into_the_first_lane() {
        let (mut s, data, _) = setup();
        assert_eq!(
            s.resolve_drop(&data, "w:c", 0),
            target(LaneKey::Main, None, None)
        );
    }

    #[test]
    fn anchors_to_a_placeholder_as_it_would_to_the_card_since_it_stands_for_a_real_tab() {
        let (mut s, mut data, mut fx) = setup();
        let mut ask = fx.agent(NeedsInput);
        ask.since_epoch = Some(500.0);
        ws_mut(&mut data, "c").agents = Some(vec![Some(ask)]);
        assert_eq!(
            s.resolve_drop(&data, "w:a", 3),
            target(LaneKey::Review, Some("c"), None)
        );
        // A placeholder is never a drag's own row.
        s.handle_move(&data, "g:c", 0);
        assert!(calls(&s).is_empty());
    }

    #[test]
    fn counts_a_placeholder_as_a_waiting_peer_so_a_held_card_drops_beside_it() {
        let (mut s, mut data, mut fx) = setup();
        let mut asks = Vec::new();
        for since in [500.0, 600.0, 700.0] {
            let mut a = fx.agent(NeedsInput);
            a.since_epoch = Some(since);
            asks.push(a);
        }
        if let Some(list) = data.workspaces.as_mut() {
            list.push(ws("d").group("g-main").agents(vec![asks[2].clone()]));
        }
        ws_mut(&mut data, "a").agents = Some(vec![Some(asks[0].clone())]);
        ws_mut(&mut data, "b").agents = Some(vec![Some(asks[1].clone())]);
        let b = by_id(&data, "b").clone();
        let d = by_id(&data, "d").clone();
        s.dismiss_waiting(&data, Some(&b));
        s.dismiss_waiting(&data, Some(&d));
        // [h:main, g:a, w:b, w:d, ...], all waiting rank; without w:d, slot 1
        // sits above g:a, so d lands before a, not before b further down.
        assert_eq!(
            s.resolve_drop(&data, "w:d", 1),
            target(LaneKey::Main, Some("a"), None)
        );
    }

    #[test]
    fn ignores_a_next_card_that_belongs_to_another_lane() {
        let (mut s, data, _) = setup();
        // Without c@review: slot 4 sits after h:review, before h:bg.
        let t = s.resolve_drop(&data, "w:c", 4);
        assert_eq!(t.lane, LaneKey::Review);
        assert_eq!(t.next_ref, None);
    }
}

mod handle_move {
    use super::*;

    #[test]
    fn reorders_before_joining_the_new_group() {
        let (mut s, data, _) = setup();
        s.handle_move(&data, "w:a", 4); // after c@review
        assert_eq!(methods(&s), ["workspace.reorder", "workspace.group.add"]);
        assert_eq!(
            calls(&s)[1],
            call(
                "workspace.group.add",
                &[("group_id", "g-review"), ("workspace_id", "a")]
            )
        );
        // Optimistic: the card shows in its new lane before the data catches up.
        assert_eq!(s.lane_of(&data, by_id(&data, "a")), LaneKey::Review);
    }

    #[test]
    fn keeps_the_cards_key_across_a_lane_move_so_its_row_is_not_rebuilt_on_the_drop() {
        let (mut s, data, _) = setup();
        let card = |s: &mut Session| {
            s.lane_entries(&data)
                .into_iter()
                .find(|e| matches!(e, LaneEntry::Ws { ws_id, .. } if ws_id == "a"))
        };
        let want = |lane| LaneEntry::Ws {
            id: "w:a".into(),
            ws_id: "a".into(),
            lane,
        };
        assert_eq!(card(&mut s), Some(want(LaneKey::Main)));
        s.handle_move(&data, "w:a", 4);
        assert_eq!(card(&mut s), Some(want(LaneKey::Review)));
    }

    #[test]
    fn removes_from_the_group_when_dropped_into_unsorted() {
        let (mut s, data, _) = setup();
        let rows: Vec<String> = ids(&mut s, &data)
            .into_iter()
            .filter(|id| id != "b@main")
            .collect();
        let slot = rows.iter().position(|id| id == "h:unsorted").unwrap() + 1;
        s.handle_move(&data, "w:b", slot);
        assert!(calls(&s).contains(&call("workspace.group.remove", &[("workspace_id", "b")])));
    }

    #[test]
    fn only_reorders_within_the_same_lane() {
        let (mut s, data, _) = setup();
        s.handle_move(&data, "w:b", 1); // above a
        assert_eq!(
            calls(&s),
            [call(
                "workspace.reorder",
                &[("workspace_id", "b"), ("index", "1")]
            )]
        );
    }

    #[test]
    fn ignores_headers_and_unknown_keys() {
        let (mut s, data, _) = setup();
        s.handle_move(&data, "h:main", 2);
        s.handle_move(&data, "w:nope", 2);
        assert!(calls(&s).is_empty());
    }

    #[test]
    fn clears_the_drag_state() {
        let (mut s, data, _) = setup();
        s.set_drag(Some(DragState {
            id: "w:a".into(),
            index: 1.0,
        }));
        s.handle_move(&data, "w:a", 1);
        assert_eq!(s.drag(), None);
    }

    #[test]
    fn ignores_a_move_from_the_hidden_lanes_under_projects() {
        let (mut s, data, _) = setup();
        s.set_mode(ViewMode::Projects);
        s.set_drag(Some(DragState {
            id: "w:a".into(),
            index: 1.0,
        }));
        s.handle_move(&data, "w:a", 4);
        assert!(calls(&s).is_empty());
        assert_eq!(s.drag(), None);
    }
}

mod is_foreign_anchor_case {
    use super::*;

    #[test]
    fn pins_a_project_groups_anchor_but_not_a_lanes_generated_one() {
        let (s, mut data, _) = setup();
        assert!(!is_foreign_anchor(&s, &data, "anchor-main"));
        if let Some(groups) = data.groups.as_mut() {
            groups.push(group("g-proj", "app-three").anchor("real-proj"));
        }
        if let Some(list) = data.workspaces.as_mut() {
            list.push(ws("real-proj").group("g-proj"));
        }
        assert!(is_foreign_anchor(&s, &data, "real-proj"));
    }
}
