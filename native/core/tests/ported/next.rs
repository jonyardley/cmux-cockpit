//! test/next.test.ts (issue #74): the Next button's queue, the capped Needs
//! you strip, and cards sorted by state inside a lane. Where a drop lands
//! is drop.ts's, left for its lane.

use cockpit_core::data::{Agent, Data, Workspace};
use cockpit_core::lane_entries::LaneEntry;
use cockpit_core::session::Session;

use crate::support::*;

const NOW: f64 = 1_000_100.0;

/// An agent that has asked for `ago` seconds.
fn asking(fx: &mut Fx, ago: f64) -> Vec<Agent> {
    vec![fx.agent(NeedsInput).since(NOW - ago)]
}

/// An agent that finished `ago` seconds ago.
fn finished(fx: &mut Fx, ago: f64) -> Vec<Agent> {
    vec![fx.agent(Idle).activity(NOW - ago).since(NOW - ago)]
}

fn working(fx: &mut Fx) -> Vec<Agent> {
    vec![fx.agent(Working).since(NOW - 10.0)]
}

/// The Main activity lane with its generated anchor, then `workspaces`.
fn scene(workspaces: Vec<Workspace>) -> Data {
    let mut list = vec![ws("anchor-main").title("Main activity").group("g-main")];
    list.extend(workspaces);
    frame(
        NOW,
        vec![group("g-main", "Main activity").anchor("anchor-main")],
        list,
    )
}

fn queue(s: &mut Session, data: &Data) -> Vec<String> {
    s.next_queue(data).iter().map(|w| w.id.clone()).collect()
}

fn step(s: &mut Session, data: &Data) -> Option<(String, usize, usize)> {
    s.next_step(data)
        .map(|st| (st.target.id.clone(), st.position, st.total))
}

fn at(id: &str, position: usize, total: usize) -> Option<(String, usize, usize)> {
    Some((id.to_string(), position, total))
}

/// cmux publishes the selection a frame later; this is that frame.
/// Opening a workspace marks its output read, and the session's own read
/// of the new selection retires its optimistic override.
fn publish_selection(s: &mut Session, data: &mut Data) {
    let selected = calls(s)
        .into_iter()
        .rev()
        .find(|(m, _)| m == "workspace.select")
        .and_then(|(_, params)| params.into_iter().find(|(k, _)| k == "workspace_id"))
        .map(|(_, v)| v);
    select_only(data, selected.as_deref());
    if let Some(id) = &selected {
        let opened = by_id(data, id).clone();
        s.is_selected(data, Some(&opened));
    }
}

/// cmux reports `id` selected (or nothing), its output read.
fn select_only(data: &mut Data, id: Option<&str>) {
    data.selected_id = id.map(str::to_string);
    for w in data.workspaces.iter_mut().flatten() {
        w.selected = Some(Some(w.id.as_str()) == id);
        if w.selected == Some(true) {
            w.unread = Some(0.0);
        }
    }
}

fn press(s: &mut Session, data: &mut Data) {
    s.jump_next(data);
    publish_selection(s, data);
}

mod the_next_queue {
    use super::*;

    fn setup() -> (Session, Data, Fx) {
        let mut fx = Fx::default();
        let data = scene(vec![
            ws("idle").group("g-main"),
            ws("ready-new")
                .group("g-main")
                .unread(1.0)
                .agents(finished(&mut fx, 60.0)),
            ws("needs-new")
                .group("g-main")
                .agents(asking(&mut fx, 30.0)),
            ws("ready-old")
                .group("g-main")
                .unread(2.0)
                .agents(finished(&mut fx, 600.0)),
            ws("needs-old")
                .group("g-main")
                .agents(asking(&mut fx, 300.0)),
            ws("busy").group("g-main").agents(working(&mut fx)),
        ]);
        (fresh(), data, fx)
    }

    #[test]
    fn lists_needs_you_then_ready_each_longest_waiting_first_and_nothing_else() {
        let (mut s, data, _) = setup();
        assert_eq!(
            queue(&mut s, &data),
            ["needs-old", "needs-new", "ready-old", "ready-new"]
        );
    }

    #[test]
    fn points_at_the_most_urgent_first_and_says_how_far_along_it_is() {
        let (mut s, data, _) = setup();
        assert_eq!(step(&mut s, &data), at("needs-old", 1, 4));
    }

    #[test]
    fn moves_on_with_each_press_then_cycles_back_to_the_top() {
        let (mut s, mut data, _) = setup();
        press(&mut s, &mut data);
        assert_eq!(data.selected_id.as_deref(), Some("needs-old"));
        assert_eq!(step(&mut s, &data), at("needs-new", 2, 4));
        press(&mut s, &mut data);
        assert_eq!(step(&mut s, &data), at("ready-old", 3, 4));
        press(&mut s, &mut data);
        // Opening a Ready one clears it, so it drops out and the next slides up.
        assert_eq!(
            queue(&mut s, &data),
            ["needs-old", "needs-new", "ready-new"]
        );
        assert_eq!(step(&mut s, &data), at("ready-new", 3, 3));
        press(&mut s, &mut data);
        assert_eq!(step(&mut s, &data), at("needs-old", 1, 2));
    }

    #[test]
    fn shows_the_move_at_once_before_cmux_publishes_the_selection() {
        let (mut s, data, _) = setup();
        s.jump_next(&data);
        assert_eq!(
            methods(&s).last().map(String::as_str),
            Some("workspace.select")
        );
        assert_eq!(step(&mut s, &data), at("needs-new", 2, 4));
    }

    #[test]
    fn moves_on_from_whatever_jon_opened_himself() {
        let (mut s, mut data, _) = setup();
        data.selected_id = Some("needs-new".into());
        ws_mut(&mut data, "needs-new").selected = Some(true);
        assert_eq!(step(&mut s, &data), at("ready-old", 3, 4));
    }

    #[test]
    fn starts_from_the_top_again_once_jon_has_moved_off_the_queue() {
        let (mut s, mut data, _) = setup();
        press(&mut s, &mut data);
        press(&mut s, &mut data);
        press(&mut s, &mut data); // ready-old, now read and off the queue
        select_only(&mut data, Some("busy"));
        assert_eq!(step(&mut s, &data), at("needs-old", 1, 3));
    }

    #[test]
    fn goes_to_the_one_after_an_opened_ready_workspace_even_when_one_ahead_leaves() {
        let (mut s, mut data, mut fx) = setup();
        press(&mut s, &mut data);
        press(&mut s, &mut data);
        press(&mut s, &mut data); // ready-old, now off the queue; ready-new followed it
        ws_mut(&mut data, "needs-old").agents = Some(vec![Some(fx.agent(Working))]);
        assert_eq!(queue(&mut s, &data), ["needs-new", "ready-new"]);
        assert_eq!(step(&mut s, &data), at("ready-new", 2, 2));
    }

    #[test]
    fn forgets_the_last_jump_once_jon_leaves_it_so_coming_back_later_starts_at_the_top() {
        let (mut s, mut data, _) = setup();
        press(&mut s, &mut data);
        press(&mut s, &mut data);
        press(&mut s, &mut data); // ready-old
        select_only(&mut data, Some("busy"));
        assert_eq!(step(&mut s, &data), at("needs-old", 1, 3));
        select_only(&mut data, Some("ready-old"));
        assert_eq!(step(&mut s, &data), at("needs-old", 1, 3));
    }

    #[test]
    fn dates_a_ready_workspace_by_when_it_finished_not_a_later_last_activity_issue_98() {
        let (mut s, mut data, mut fx) = setup();
        let a = fx.agent(Idle).since(NOW - 900.0).activity(NOW - 30.0);
        ws_mut(&mut data, "ready-new").agents = Some(vec![Some(a)]);
        assert_eq!(
            queue(&mut s, &data),
            ["needs-old", "needs-new", "ready-new", "ready-old"]
        );
    }

    #[test]
    fn dates_a_ready_workspace_by_its_finished_agent_not_a_fresh_idle_session_beside_it() {
        let (mut s, mut data, mut fx) = setup();
        let mut agents = finished(&mut fx, 600.0);
        agents.push(fx.agent(Idle).since(NOW - 5.0));
        ws_mut(&mut data, "ready-old").agents = Some(agents.into_iter().map(Some).collect());
        assert_eq!(
            queue(&mut s, &data),
            ["needs-old", "needs-new", "ready-old", "ready-new"]
        );
    }

    #[test]
    fn hides_when_the_only_one_waiting_is_the_one_jon_is_on() {
        let mut fx = Fx::default();
        let mut data = scene(vec![
            ws("n").group("g-main").agents(asking(&mut fx, 60.0)),
            ws("busy").group("g-main").agents(working(&mut fx)),
        ]);
        let mut s = fresh();
        assert_eq!(step(&mut s, &data), at("n", 1, 1));
        press(&mut s, &mut data);
        assert_eq!(step(&mut s, &data), None);
    }

    #[test]
    fn is_hidden_when_nothing_needs_jon_or_is_ready() {
        let mut fx = Fx::default();
        let data = scene(vec![
            ws("idle").group("g-main"),
            ws("busy").group("g-main").agents(working(&mut fx)),
        ]);
        let mut s = fresh();
        assert_eq!(step(&mut s, &data), None);
        s.jump_next(&data);
        assert!(s.outbox().is_empty());
    }
}

mod needs_you_with_no_strip {
    use super::*;

    #[test]
    fn lists_every_waiting_session_oldest_first_with_no_cap() {
        let mut fx = Fx::default();
        let data = scene(
            ["a", "b", "c", "d", "e", "f"]
                .iter()
                .enumerate()
                .map(|(i, id)| {
                    ws(id)
                        .group("g-main")
                        .agents(asking(&mut fx, 600.0 - i as f64 * 60.0))
                })
                .collect(),
        );
        let mut s = fresh();
        let listed: Vec<&str> = s.needs_list(&data).iter().map(|w| w.id.as_str()).collect();
        assert_eq!(listed, ["a", "b", "c", "d", "e", "f"]);
    }
}

mod cards_sorted_by_state_inside_a_lane {
    use super::*;

    /// Four older asks wait in Unsorted, which `lane` leaves out as it
    /// reads Main activity's cards. (The TypeScript lifts them into the
    /// strip; since R4.5, issue #281, every card stays in its lane.)
    fn setup() -> (Session, Data, Fx) {
        let mut fx = Fx::default();
        let mut list = vec![
            ws("i1").group("g-main"),
            ws("w1").group("g-main").agents(working(&mut fx)),
            ws("i2").group("g-main"),
            ws("r1")
                .group("g-main")
                .unread(1.0)
                .agents(finished(&mut fx, 60.0)),
            ws("n1").group("g-main").agents(asking(&mut fx, 60.0)),
            ws("i3").group("g-main"),
        ];
        for id in ["q1", "q2", "q3", "q4"] {
            list.push(ws(id).agents(asking(&mut fx, 600.0)));
        }
        (fresh(), scene(list), fx)
    }

    fn lane(s: &mut Session, data: &Data) -> Vec<String> {
        s.lane_entries(data)
            .into_iter()
            .filter_map(|e| match e {
                LaneEntry::Ws { ws_id, lane, .. } if lane.as_str() == "main" => Some(ws_id),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn puts_needs_you_then_ready_then_working_then_the_rest_keeping_tab_order_within_a_state() {
        let (mut s, data, _) = setup();
        assert_eq!(lane(&mut s, &data), ["n1", "r1", "w1", "i1", "i2", "i3"]);
        let ranks: Vec<u8> = ["n1", "r1", "w1", "i1"]
            .iter()
            .map(|id| s.state_rank(&data, Some(by_id(&data, id))))
            .collect();
        assert_eq!(ranks, [0, 4, 5, 6]);
    }

    /// A pin puts a card under the cards that need you and above Ready.
    #[test]
    fn puts_a_pinned_card_under_needs_you_and_above_ready() {
        let (mut s, mut data, _) = setup();
        ws_mut(&mut data, "i1").pinned = Some(true);
        assert_eq!(lane(&mut s, &data), ["n1", "i1", "r1", "w1", "i2", "i3"]);
        ws_mut(&mut data, "n1").pinned = Some(true);
        assert_eq!(lane(&mut s, &data), ["n1", "i1", "r1", "w1", "i2", "i3"]);
        assert_eq!(s.state_rank(&data, Some(by_id(&data, "n1"))), 0);
    }

    /// Pinned cards keep state order among themselves: Ready above idle.
    #[test]
    fn keeps_state_order_among_pinned_cards() {
        let (mut s, mut data, _) = setup();
        ws_mut(&mut data, "i1").pinned = Some(true);
        ws_mut(&mut data, "r1").pinned = Some(true);
        assert_eq!(lane(&mut s, &data), ["n1", "r1", "i1", "w1", "i2", "i3"]);
    }

    /// The hold keeps the selected card's state, not its pin.
    #[test]
    fn moves_the_selected_card_at_once_when_it_is_unpinned() {
        let (mut s, mut data, _) = setup();
        ws_mut(&mut data, "i1").pinned = Some(true);
        assert_eq!(lane(&mut s, &data), ["n1", "i1", "r1", "w1", "i2", "i3"]);
        select_only(&mut data, Some("i1"));
        ws_mut(&mut data, "i1").pinned = None;
        assert_eq!(lane(&mut s, &data), ["n1", "r1", "w1", "i1", "i2", "i3"]);
    }

    #[test]
    fn re_sorts_a_card_when_its_state_changes() {
        let (mut s, mut data, mut fx) = setup();
        let ask = fx.agent(NeedsInput).since(NOW - 10.0);
        ws_mut(&mut data, "i3").agents = Some(vec![Some(ask)]);
        assert_eq!(lane(&mut s, &data), ["n1", "i3", "r1", "w1", "i1", "i2"]);
    }

    /// Adapted: the TypeScript case reads r1's rank kept from earlier cases
    /// in the file; here the lane is read once with r1 unselected first.
    #[test]
    fn keeps_a_card_it_has_just_opened_in_place_while_it_is_selected() {
        let (mut s, mut data, _) = setup();
        assert_eq!(lane(&mut s, &data), ["n1", "r1", "w1", "i1", "i2", "i3"]);
        select_only(&mut data, Some("r1"));
        assert_eq!(lane(&mut s, &data), ["n1", "r1", "w1", "i1", "i2", "i3"]);
        // Once Jon moves on, it settles among the idle cards.
        select_only(&mut data, Some("i1"));
        assert_eq!(lane(&mut s, &data), ["n1", "w1", "i1", "i2", "r1", "i3"]);
    }
}
