//! Placing a card: where `m` and a lane, shift with up or down, and a drag
//! would put it, as a lane and the card it lands above. Plain decisions on
//! the pane's model, so the keys and the mouse share them and the tests
//! cover them. The core works out the tab order from that (drop.ts).

use cockpit_core::panel::LaneKey;

use crate::model::{PaneModel, Row};

/// Where a card lands: a lane, and the card it lands above in that lane,
/// or None for the lane's end.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Place {
    pub lane: LaneKey,
    pub before: Option<String>,
}

/// What one line of the drawn body is, for the mouse.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Spot {
    /// Nothing a card can land on: the gap above the lanes, say.
    Blank,
    /// A lane's header: a drop here lands at the top of the lane.
    Header(LaneKey),
    /// A line of a card in a lane.
    Card { id: String, lane: LaneKey },
    /// The gap below a lane, before the next header: its end.
    End(LaneKey),
}

/// What sits on body line `line`. Below the last line is the end of the
/// last lane, so a drop at the bottom of the pane files there.
pub fn spot_at(spots: &[Spot], line: usize) -> Spot {
    if let Some(s) = spots.get(line) {
        return s.clone();
    }
    let last = spots.iter().rev().find_map(|s| match s {
        Spot::Header(lane) | Spot::End(lane) => Some(*lane),
        Spot::Card { lane, .. } => Some(*lane),
        Spot::Blank => None,
    });
    last.map_or(Spot::Blank, Spot::End)
}

/// Where a card dragged onto `spot` would land, or None when it would
/// stay where it is or the spot takes no card. A lane sorts its cards by
/// state and the order holds only among cards in the same state, so, as
/// drop.ts does, the drop anchors to the nearest card in the dragged
/// card's own state: above the first one below the spot, else just after
/// the last one above it, else above whatever is below the spot.
pub fn drop_on(model: &PaneModel, dragged: &str, spot: &Spot) -> Option<Place> {
    let (lane, over) = match spot {
        Spot::Header(lane) => (*lane, None),
        Spot::Card { id, lane } if id != dragged => (*lane, Some(id.as_str())),
        Spot::End(lane) => (*lane, None),
        Spot::Card { .. } | Spot::Blank => return None,
    };
    let rows: Vec<&Row> = model
        .lane_rows(lane)
        .into_iter()
        .filter(|r| r.ws_id() != dragged)
        .collect();
    // The slot the drop opens: above the card under the mouse, at the top
    // under a header, at the end below a lane.
    let at = match (spot, over) {
        (_, Some(id)) => rows.iter().position(|r| r.ws_id() == id)?,
        (Spot::Header(_), None) => 0,
        _ => rows.len(),
    };
    let before = landing(&rows, at, rank_of(model, dragged)).map(str::to_string);
    moves(model, dragged, Place { lane, before })
}

/// The card a drop into slot `at` of `rows` lands above, for a card in
/// state `rank`.
fn landing<'a>(rows: &[&'a Row], at: usize, rank: Option<u8>) -> Option<&'a str> {
    let peer = |r: &&&Row| Some(r.rank()) == rank;
    if let Some(below) = rows.iter().skip(at).find(peer) {
        return Some(below.ws_id());
    }
    if let Some(above) = rows.iter().take(at).rposition(|r| peer(&r)) {
        return rows.get(above + 1).map(|r| r.ws_id());
    }
    rows.get(at).map(|r| r.ws_id())
}

/// The state rank of `id`'s card.
fn rank_of(model: &PaneModel, id: &str) -> Option<u8> {
    model
        .lanes
        .iter()
        .flat_map(|l| &l.rows)
        .find(|r| r.ws_id() == id)
        .map(Row::rank)
}

/// Where shift with up (`up`) or down puts `id` in its own lane: above the
/// card above it, or above the one two below (the end when that is the
/// last). Only among cards in its own state, since the lane sorts by
/// state: None at either end of that run, or for a card in no lane.
pub fn reorder(model: &PaneModel, id: &str, up: bool) -> Option<Place> {
    if !model.movable(id) {
        return None;
    }
    let lane = model.lane_of(id)?;
    let rows = model.lane_rows(lane);
    let i = rows.iter().position(|r| r.ws_id() == id)?;
    let rank = rows.get(i)?.rank();
    let before = if up {
        let above = rows.get(i.checked_sub(1)?)?;
        (above.rank() == rank).then_some(Some(above.ws_id()))?
    } else {
        let below = rows.get(i + 1)?;
        (below.rank() == rank).then_some(rows.get(i + 2).map(|r| r.ws_id()))?
    };
    moves(
        model,
        id,
        Place {
            lane,
            before: before.map(str::to_string),
        },
    )
}

/// Where `m` and a lane puts `id`: the end of that lane. None when it is
/// already there, or anchors another group.
pub fn to_lane(model: &PaneModel, id: &str, lane: LaneKey) -> Option<Place> {
    if model.lane_of(id) == Some(lane) || !model.movable(id) {
        return None;
    }
    Some(Place { lane, before: None })
}

/// `place`, unless it is where `id` already sits: its own lane, above the
/// card already below it.
fn moves(model: &PaneModel, id: &str, place: Place) -> Option<Place> {
    if model.lane_of(id) != Some(place.lane) {
        return Some(place);
    }
    let rows = model.lane_rows(place.lane);
    let next = rows
        .iter()
        .position(|r| r.ws_id() == id)
        .and_then(|i| rows.get(i + 1))
        .map(|r| r.ws_id());
    if next == place.before.as_deref() {
        None
    } else {
        Some(place)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::fixtures::{card, lane};

    /// Main holds a, b and c, all working; Review holds g (waiting) above
    /// x (working) and y (idle).
    fn model() -> PaneModel {
        PaneModel {
            lanes: vec![
                lane(
                    LaneKey::Main,
                    vec![
                        card("a", 2, false),
                        card("b", 2, false),
                        card("c", 2, false),
                    ],
                ),
                lane(
                    LaneKey::Review,
                    vec![card("g", 0, true), card("x", 2, false), card("y", 3, false)],
                ),
                lane(LaneKey::Parked, Vec::new()),
            ],
            ..PaneModel::default()
        }
    }

    fn at(lane: LaneKey, before: Option<&str>) -> Option<Place> {
        Some(Place {
            lane,
            before: before.map(str::to_string),
        })
    }

    fn on(id: &str, lane: LaneKey) -> Spot {
        Spot::Card {
            id: id.into(),
            lane,
        }
    }

    #[test]
    fn reorders_up_above_the_card_above() {
        let m = model();
        assert_eq!(reorder(&m, "c", true), at(LaneKey::Main, Some("b")));
        assert_eq!(reorder(&m, "b", true), at(LaneKey::Main, Some("a")));
        assert_eq!(reorder(&m, "a", true), None, "already at the top");
    }

    #[test]
    fn reorders_down_above_the_card_two_below_or_to_the_end() {
        let m = model();
        assert_eq!(reorder(&m, "a", false), at(LaneKey::Main, Some("c")));
        assert_eq!(reorder(&m, "b", false), at(LaneKey::Main, None));
        assert_eq!(reorder(&m, "c", false), None, "already at the bottom");
    }

    #[test]
    fn reorders_only_among_cards_in_the_same_state() {
        let m = model();
        assert_eq!(reorder(&m, "x", true), None, "the waiting card sorts first");
        assert_eq!(reorder(&m, "x", false), None, "the idle card sorts after");
        assert_eq!(reorder(&m, "nowhere", true), None);
    }

    #[test]
    fn moves_to_the_end_of_another_lane_only() {
        let m = model();
        assert_eq!(to_lane(&m, "a", LaneKey::Parked), at(LaneKey::Parked, None));
        assert_eq!(to_lane(&m, "a", LaneKey::Main), None, "already there");
    }

    #[test]
    fn drops_above_the_card_under_the_mouse_in_the_same_state() {
        let m = model();
        assert_eq!(
            drop_on(&m, "a", &on("x", LaneKey::Review)),
            at(LaneKey::Review, Some("x"))
        );
    }

    #[test]
    fn a_drop_among_other_states_anchors_to_the_cards_own_state() {
        let m = model();
        assert_eq!(
            drop_on(&m, "a", &on("g", LaneKey::Review)),
            at(LaneKey::Review, Some("x")),
            "above the waiting card: still after it, above x"
        );
        assert_eq!(
            drop_on(&m, "a", &on("y", LaneKey::Review)),
            at(LaneKey::Review, Some("y")),
            "above the idle card: just after x, the last working one"
        );
        assert_eq!(
            drop_on(&m, "a", &Spot::End(LaneKey::Review)),
            at(LaneKey::Review, Some("y")),
            "at the end: just after x"
        );
        assert_eq!(
            drop_on(&m, "y", &on("g", LaneKey::Review)),
            at(LaneKey::Review, Some("g")),
            "with no other card in its state, the card below, as drop.ts does"
        );
    }

    #[test]
    fn drops_at_the_top_of_a_lane_on_its_header_and_the_end_below_it() {
        let m = model();
        let main = Spot::Header(LaneKey::Main);
        assert_eq!(drop_on(&m, "x", &main), at(LaneKey::Main, Some("a")));
        let parked = Spot::Header(LaneKey::Parked);
        assert_eq!(drop_on(&m, "a", &parked), at(LaneKey::Parked, None));
        let end = Spot::End(LaneKey::Main);
        assert_eq!(drop_on(&m, "x", &end), at(LaneKey::Main, None));
    }

    #[test]
    fn a_drop_that_leaves_the_card_where_it_is_does_nothing() {
        let m = model();
        assert_eq!(
            drop_on(&m, "a", &on("a", LaneKey::Main)),
            None,
            "onto itself"
        );
        assert_eq!(
            drop_on(&m, "a", &on("b", LaneKey::Main)),
            None,
            "above the card below it"
        );
        assert_eq!(
            drop_on(&m, "a", &Spot::Header(LaneKey::Main)),
            None,
            "the top"
        );
        assert_eq!(drop_on(&m, "c", &Spot::End(LaneKey::Main)), None);
        assert_eq!(
            drop_on(&m, "c", &on("a", LaneKey::Main)),
            at(LaneKey::Main, Some("a")),
            "up its lane"
        );
    }

    #[test]
    fn takes_no_drop_on_a_gap() {
        let m = model();
        assert_eq!(drop_on(&m, "a", &Spot::Blank), None);
    }

    #[test]
    fn reads_below_the_last_line_as_the_last_lanes_end() {
        let spots = vec![
            Spot::Blank,
            Spot::Header(LaneKey::Main),
            on("a", LaneKey::Main),
        ];
        assert_eq!(spot_at(&spots, 1), Spot::Header(LaneKey::Main));
        assert_eq!(spot_at(&spots, 9), Spot::End(LaneKey::Main));
        assert_eq!(spot_at(&[Spot::Blank], 9), Spot::Blank);
    }
}
