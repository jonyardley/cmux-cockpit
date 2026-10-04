//! test/reveal.test.ts: tapping a Needs you row or Next unfolds what hides
//! the card, so the selection lands somewhere Jon can see it. A card the
//! strip lists shows there, not in its lane, but its lane unfolds too, so
//! the card is in view when it comes back after an answer.

use cockpit_core::data::{Agent, Data, Workspace};
use cockpit_core::lane_entries::LaneEntry;
use cockpit_core::lanes::{LaneKey, lane_by_key};
use cockpit_core::persist::ViewMode;
use cockpit_core::session::Session;

use crate::support::*;

const NOW: f64 = 1_000_100.0;

fn asking(fx: &mut Fx) -> Vec<Agent> {
    vec![fx.agent(NeedsInput).since(NOW - 30.0)]
}

/// Finished with output Jon has not read: Ready, so Next goes to it and
/// its card shows in its lane.
fn ready(fx: &mut Fx, w: Workspace) -> Workspace {
    w.unread(1.0)
        .agents(vec![fx.agent(Idle).activity(1.0).since(1.0)])
}

fn setup() -> (Session, Data, Fx) {
    let mut fx = Fx::default();
    let data = frame(
        NOW,
        vec![
            group("g-main", "Main activity").anchor("anchor-main"),
            group("g-parked", "Parked")
                .anchor("anchor-parked")
                .collapsed(true),
        ],
        vec![
            ws("anchor-main").title("Main activity").group("g-main"),
            ws("a").group("g-main"),
            ws("anchor-parked")
                .title("Parked")
                .group("g-parked")
                .agents(asking(&mut fx)),
            ready(&mut fx, ws("p").group("g-parked")),
            ready(&mut fx, ws("u")),
            ws("n").group("g-parked").agents(asking(&mut fx)),
        ],
    );
    (fresh(), data, fx)
}

fn card_shown(s: &mut Session, data: &Data, id: &str) -> bool {
    s.lane_entries(data)
        .iter()
        .any(|e| matches!(e, LaneEntry::Ws { ws_id, .. } if ws_id == id))
}

mod revealing_a_card_from_needs_you_or_next {
    use super::*;

    #[test]
    fn unfolds_a_folded_lane_before_selecting_its_card() {
        let (mut s, data, _) = setup();
        let parked = lane_by_key(LaneKey::Parked);
        assert!(s.is_collapsed(&data, &parked));
        assert!(!card_shown(&mut s, &data, "p"));
        s.reveal_workspace(&data, Some(by_id(&data, "p")));
        assert!(!s.is_collapsed(&data, &parked));
        assert!(card_shown(&mut s, &data, "p"));
        assert_eq!(methods(&s), ["workspace.group.expand", "workspace.select"]);
    }

    #[test]
    fn unfolds_unsorted_which_is_folded_locally_not_in_cmux() {
        let (mut s, data, _) = setup();
        s.set_unsorted_collapsed(true);
        s.reveal_workspace(&data, Some(by_id(&data, "u")));
        assert!(!s.unsorted_collapsed());
        assert!(card_shown(&mut s, &data, "u"));
        assert_eq!(methods(&s), ["workspace.select"]);
    }

    #[test]
    fn unfolds_the_lane_of_a_card_the_strip_lists_so_its_card_shows_once_answered() {
        let (mut s, data, _) = setup();
        let parked = lane_by_key(LaneKey::Parked);
        assert!(!card_shown(&mut s, &data, "n"));
        s.reveal_workspace(&data, Some(by_id(&data, "n")));
        assert!(!s.is_collapsed(&data, &parked));
        assert_eq!(methods(&s), ["workspace.group.expand", "workspace.select"]);
    }

    #[test]
    fn leaves_an_open_lane_alone() {
        let (mut s, data, _) = setup();
        s.reveal_workspace(&data, Some(by_id(&data, "a")));
        assert_eq!(methods(&s), ["workspace.select"]);
    }

    #[test]
    fn only_selects_a_lanes_generated_anchor_its_status_is_on_the_header_folded_or_not() {
        let (mut s, data, _) = setup();
        assert!(s.is_collapsed(&data, &lane_by_key(LaneKey::Parked)));
        s.reveal_workspace(&data, Some(by_id(&data, "anchor-parked")));
        assert_eq!(methods(&s), ["workspace.select"]);
    }

    #[test]
    fn switches_projects_to_all_for_a_generated_anchor_so_its_lane_header_shows() {
        let (mut s, data, _) = setup();
        s.set_mode(ViewMode::Projects);
        s.reveal_workspace(&data, Some(by_id(&data, "anchor-parked")));
        assert_eq!(s.mode(), ViewMode::All);
        assert!(s.is_collapsed(&data, &lane_by_key(LaneKey::Parked)));
        assert_eq!(methods(&s), ["workspace.select"]);
    }

    /// Partly ported: the Projects rows are by-project.ts's; here the fold and the calls.
    #[test]
    fn unfolds_the_cards_project_in_projects_and_leaves_the_lanes_alone() {
        let (mut s, data, _) = setup();
        s.set_mode(ViewMode::Projects);
        let k = s.project_key(by_id(&data, "p"));
        s.set_collapsed_projects(vec![k.clone()]);
        assert!(s.is_collapsed(&data, &lane_by_key(LaneKey::Parked)));
        s.reveal_workspace(&data, Some(by_id(&data, "p")));
        assert!(!s.is_project_collapsed(&k));
        // No workspace.group.expand: the lane stays as Jon left it.
        assert_eq!(methods(&s), ["workspace.select"]);
    }

    #[test]
    fn does_the_same_for_next() {
        let (mut s, mut data, _) = setup();
        // Only the Unsorted card is left waiting or Ready, so Next goes there.
        for id in ["p", "n", "anchor-parked"] {
            ws_mut(&mut data, id).agents = Some(vec![]);
        }
        s.set_unsorted_collapsed(true);
        s.jump_next(&data);
        assert!(!s.unsorted_collapsed());
        assert_eq!(
            calls(&s),
            [call("workspace.select", &[("workspace_id", "u")])]
        );
    }
}
