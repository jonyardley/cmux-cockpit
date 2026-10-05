//! Placing a card: where `m` and a lane, shift with up or down, and a drag
//! would put it, as a lane and the card it lands above. Plain decisions on
//! the pane's model, so the keys and the mouse share them and the tests
//! cover them. The core works out the tab order from that (drop.ts).

use cockpit_core::lanes::LaneKey;

use crate::model::PaneModel;

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
    /// A row in the Needs you strip.
    Needs(String),
    /// A lane's header: a drop here lands at the top of the lane.
    Header(LaneKey),
    /// A line of a card in a lane.
    Card { id: String, lane: LaneKey },
    /// A placeholder, standing for a card waiting in Needs you.
    Ghost { id: String, lane: LaneKey },
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
        Spot::Card { lane, .. } | Spot::Ghost { lane, .. } => Some(*lane),
        Spot::Blank | Spot::Needs(_) => None,
    });
    last.map_or(Spot::Blank, Spot::End)
}

/// Where a card dragged onto `spot` would land, or None when it would
/// stay where it is or the spot takes no card.
pub fn drop_on(model: &PaneModel, dragged: &str, spot: &Spot) -> Option<Place> {
    let place = match spot {
        Spot::Header(lane) => Place {
            lane: *lane,
            before: model
                .lane_rows(*lane)
                .into_iter()
                .find(|id| *id != dragged)
                .map(str::to_string),
        },
        Spot::Card { id, lane } | Spot::Ghost { id, lane } if id != dragged => Place {
            lane: *lane,
            before: Some(id.clone()),
        },
        Spot::End(lane) => Place {
            lane: *lane,
            before: None,
        },
        Spot::Card { .. } | Spot::Ghost { .. } | Spot::Blank | Spot::Needs(_) => return None,
    };
    moves(model, dragged, place)
}

/// Where shift with up (`up`) or down puts `id` in its own lane: above the
/// card above it, or above the one two below (the end when that is the
/// last). None at either end, for a card in no lane, or for a Needs you
/// row: it is not in a lane's order on screen.
pub fn reorder(model: &PaneModel, id: &str, up: bool) -> Option<Place> {
    if model.in_strip(id) {
        return None;
    }
    let lane = model.lane_of(id)?;
    let rows = model.lane_rows(lane);
    let i = rows.iter().position(|r| *r == id)?;
    let before = if up {
        Some(*rows.get(i.checked_sub(1)?)?)
    } else {
        rows.get(i + 1)?;
        rows.get(i + 2).copied()
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
/// already there.
pub fn to_lane(model: &PaneModel, id: &str, lane: LaneKey) -> Option<Place> {
    if model.lane_of(id) == Some(lane) {
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
        .position(|r| *r == id)
        .and_then(|i| rows.get(i + 1))
        .copied();
    if next == place.before.as_deref() {
        None
    } else {
        Some(place)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{Card, Icon, Lane, Row};
    use cockpit_core::theme::Token;
    use cockpit_core::ui::PillColors;

    fn card(id: &str) -> Row {
        Row::Card(Card {
            ws_id: id.into(),
            icon: Icon {
                glyph: "●",
                ink: None,
            },
            title: id.into(),
            status: String::new(),
            status_ink: Token::MetaText,
            left_off: String::new(),
            detail: String::new(),
            detail_lines: 1,
            waiting: false,
        })
    }

    fn lane(key: LaneKey, rows: Vec<Row>) -> Lane {
        Lane {
            key,
            empty: rows.is_empty(),
            name: key.as_str().into(),
            faint: false,
            marker: Token::LaneMain,
            anchor: None,
            count: rows.len(),
            pill: PillColors {
                bg: Token::CountBg,
                fg: Token::MetaText,
            },
            dot: None,
            collapsed: false,
            merge_ready: String::new(),
            rows,
        }
    }

    /// Main holds a, b and c; Review holds x and a placeholder g.
    fn model() -> PaneModel {
        let ghost = Row::Ghost {
            ws_id: "g".into(),
            title: "g".into(),
            text: "your turn".into(),
        };
        PaneModel {
            lanes: vec![
                lane(LaneKey::Main, vec![card("a"), card("b"), card("c")]),
                lane(LaneKey::Review, vec![card("x"), ghost]),
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
    fn reorders_past_a_placeholder_as_past_a_card() {
        let m = model();
        assert_eq!(reorder(&m, "x", false), at(LaneKey::Review, None));
        assert_eq!(reorder(&m, "nowhere", true), None);
    }

    #[test]
    fn moves_to_the_end_of_another_lane_only() {
        let m = model();
        assert_eq!(to_lane(&m, "a", LaneKey::Parked), at(LaneKey::Parked, None));
        assert_eq!(to_lane(&m, "a", LaneKey::Main), None, "already there");
    }

    #[test]
    fn drops_above_the_card_under_the_mouse() {
        let m = model();
        let on_x = Spot::Card {
            id: "x".into(),
            lane: LaneKey::Review,
        };
        assert_eq!(drop_on(&m, "a", &on_x), at(LaneKey::Review, Some("x")));
        let on_g = Spot::Ghost {
            id: "g".into(),
            lane: LaneKey::Review,
        };
        assert_eq!(drop_on(&m, "a", &on_g), at(LaneKey::Review, Some("g")));
    }

    #[test]
    fn drops_at_the_top_of_a_lane_on_its_header_and_the_end_below_it() {
        let m = model();
        let review = Spot::Header(LaneKey::Review);
        assert_eq!(drop_on(&m, "a", &review), at(LaneKey::Review, Some("x")));
        let parked = Spot::Header(LaneKey::Parked);
        assert_eq!(drop_on(&m, "a", &parked), at(LaneKey::Parked, None));
        let end = Spot::End(LaneKey::Review);
        assert_eq!(drop_on(&m, "a", &end), at(LaneKey::Review, None));
    }

    #[test]
    fn a_drop_that_leaves_the_card_where_it_is_does_nothing() {
        let m = model();
        let on_a = Spot::Card {
            id: "a".into(),
            lane: LaneKey::Main,
        };
        assert_eq!(drop_on(&m, "a", &on_a), None, "onto itself");
        let on_b = Spot::Card {
            id: "b".into(),
            lane: LaneKey::Main,
        };
        assert_eq!(drop_on(&m, "a", &on_b), None, "above the card below it");
        let main = Spot::Header(LaneKey::Main);
        assert_eq!(drop_on(&m, "a", &main), None, "the top, where it is");
        assert_eq!(drop_on(&m, "c", &Spot::End(LaneKey::Main)), None);
        assert_eq!(
            drop_on(&m, "c", &on_a),
            at(LaneKey::Main, Some("a")),
            "up its lane"
        );
    }

    #[test]
    fn takes_no_drop_on_the_strip_or_a_gap() {
        let m = model();
        assert_eq!(drop_on(&m, "a", &Spot::Blank), None);
        assert_eq!(drop_on(&m, "a", &Spot::Needs("n".into())), None);
    }

    #[test]
    fn reads_below_the_last_line_as_the_last_lanes_end() {
        let spots = vec![
            Spot::Blank,
            Spot::Header(LaneKey::Main),
            Spot::Card {
                id: "a".into(),
                lane: LaneKey::Main,
            },
        ];
        assert_eq!(spot_at(&spots, 1), Spot::Header(LaneKey::Main));
        assert_eq!(spot_at(&spots, 9), Spot::End(LaneKey::Main));
        assert_eq!(spot_at(&[Spot::Blank], 9), Spot::Blank);
    }
}
