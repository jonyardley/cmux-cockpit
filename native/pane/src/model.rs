//! What the pane draws: the core's panel model (cockpit_core::panel),
//! built once per frame from the core, with the words only the terminal
//! draws (its keys overlay and lane picker) and the cut-word check's list.

pub use cockpit_core::panel::*;
pub use cockpit_core::panel::{Panel as PaneModel, PanelView as PaneView};

/// The keys the `?` overlay lists: the key, then what it does.
pub const KEYS: [(&str, &str); 14] = [
    ("↑ ↓", "move between cards"),
    ("shift ↑ ↓", "reorder in its lane"),
    ("m 1-5", "move to a lane"),
    ("drag", "move to a lane or spot"),
    ("Enter", "switch to it"),
    ("d", "dismiss from Needs you"),
    ("+", "session in project"),
    ("e", "edit project"),
    ("n", "new project"),
    ("Space", "card or project menu"),
    ("Tab", "All or Projects"),
    ("?", "show or hide the keys"),
    ("q", "quit"),
    ("Esc", "close this"),
];
/// The overlay's title.
pub const KEYS_TITLE: &str = "Keys";
/// The lane picker's title, after `m`.
pub const PICK_TITLE: &str = "Move to lane";
/// The lane picker's last line: how to leave it.
pub const PICK_CANCEL: (&str, &str) = ("Esc", "cancel");
/// What leads a row's PR title after the session's (cards.ts denseRow).
pub const PR_TITLE_DOT: &str = "· ";

/// The rows of a keys box that fit `room` lines: all of them, or as many
/// from the top as fit with the last kept, since it says how to close the
/// box.
pub fn fit_rows<T: Copy>(rows: &[T], room: usize) -> Vec<T> {
    if rows.len() <= room {
        return rows.to_vec();
    }
    let Some((last, rest)) = rows.split_last() else {
        return Vec::new();
    };
    if room == 0 {
        return Vec::new();
    }
    let mut out: Vec<T> = rest.iter().take(room - 1).copied().collect();
    out.push(*last);
    out
}

/// How many lanes the picker offers: one digit each, 1 to 9. With nine or
/// more configured lanes, the ones after the ninth (Unsorted among them)
/// are not offered.
const PICKABLE: usize = 9;

/// The lane a digit picks after `m`: 1 is the first lane, in display order.
pub fn lane_for_digit(model: &PaneModel, c: char) -> Option<LaneKey> {
    let n = c.to_digit(10)?;
    let i = usize::try_from(n).ok()?.checked_sub(1)?;
    model
        .lane_picks
        .iter()
        .take(PICKABLE)
        .nth(i)
        .map(|(key, _)| key.clone())
}

/// The lane picker's rows: each digit and the lane it picks, then Esc.
pub fn pick_rows(model: &PaneModel) -> Vec<(String, &str)> {
    let mut rows: Vec<(String, &str)> = model
        .lane_picks
        .iter()
        .take(PICKABLE)
        .enumerate()
        .map(|(i, (_, name))| ((i + 1).to_string(), name.as_str()))
        .collect();
    rows.push((PICK_CANCEL.0.to_string(), PICK_CANCEL.1));
    rows
}

/// Every piece of text the pane can draw, for the test that checks no
/// word is cut.
pub fn words(model: &PaneModel) -> Vec<String> {
    let mut out: Vec<String> = [
        ALL_LABEL,
        PROJECTS_LABEL,
        KEYS_HINT,
        NEXT_LABEL,
        NEXT_NOTHING,
        KEYS_TITLE,
        PICK_TITLE,
        PICK_CANCEL.0,
        PICK_CANCEL.1,
        DROP_HERE,
        DROP_AT_END,
        DIRTY_MARK,
        NEW_PROJECT_LABEL,
        QUIET_LABEL,
        PLUS_MARK,
    ]
    .iter()
    .map(|s| (*s).to_string())
    .collect();
    for (key, what) in KEYS {
        out.push(key.to_string());
        out.push(what.to_string());
    }
    for (key, what) in pick_rows(model) {
        out.push(key);
        out.push(what.to_string());
    }
    if let NextLine::Step { title, place, .. } = &model.next {
        out.push(title.clone());
        out.push(place.clone());
    }
    out.push(model.needs.label.clone());
    out.push(model.needs.wait.clone());
    for lane in &model.lanes {
        out.push(lane.name.clone());
        out.push(lane.count.to_string());
        if let Some(a) = &lane.anchor {
            out.push(a.unread.clone());
        }
        out.push(lane.merge_ready.clone());
        for row in &lane.rows {
            card_words(row.card(), &mut out);
        }
    }
    for row in &model.projects {
        match row {
            ProjectRow::Header(h) => {
                out.push(h.name.clone());
                out.push(h.count.to_string());
            }
            ProjectRow::Card(c) => card_words(c, &mut out),
            ProjectRow::QuietHeader { count, .. } => out.push(count.to_string()),
            ProjectRow::Quiet { name, .. } => out.push(name.clone()),
            ProjectRow::NewProject => {}
            ProjectRow::Editor(e) => {
                out.push(e.name.clone());
                out.push(e.root.clone());
            }
        }
    }
    out
}

/// A card's words, for `words`.
fn card_words(c: &Card, out: &mut Vec<String>) {
    out.push(c.title.clone());
    out.push(c.status.clone());
    out.push(c.age.clone());
    out.push(c.left_off.clone());
    out.push(c.detail.clone());
    if let Some(pr) = &c.row_pr {
        out.push(pr.tag.clone());
        if !pr.title.is_empty() {
            out.push(format!("{PR_TITLE_DOT}{}", pr.title));
        }
    }
    for chip in &c.chips {
        out.extend(chip.pieces.iter().map(|p| p.text.clone()));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn picks_lanes_by_digit_in_display_order() {
        let mut core = cockpit_core::app::Model {
            data: Some(cockpit_core::Data::default()),
            ..Default::default()
        };
        let m = PaneModel::from_core(&mut core);
        assert_eq!(lane_for_digit(&m, '1'), Some(LaneKey::from("main")));
        assert_eq!(lane_for_digit(&m, '4'), Some(LaneKey::from("parked")));
        assert_eq!(lane_for_digit(&m, '5'), Some(LaneKey::unsorted()));
        assert_eq!(lane_for_digit(&m, '0'), None);
        assert_eq!(lane_for_digit(&m, '6'), None);
        assert_eq!(lane_for_digit(&m, 'm'), None);
        let rows = pick_rows(&m);
        assert_eq!(rows.first(), Some(&("1".to_string(), "Main activity")));
        assert_eq!(rows.last(), Some(&("Esc".to_string(), "cancel")));
    }

    #[test]
    fn picks_from_the_configured_lanes() {
        let mut core = cockpit_core::app::Model {
            data: Some(cockpit_core::Data::default()),
            ..Default::default()
        };
        let doing = cockpit_core::lanes::LaneConfig {
            name: "Doing".into(),
            ..Default::default()
        };
        core.session.set_lanes(&[doing]);
        let m = PaneModel::from_core(&mut core);
        assert_eq!(lane_for_digit(&m, '1'), Some(LaneKey::from("Doing")));
        assert_eq!(lane_for_digit(&m, '2'), Some(LaneKey::unsorted()));
        assert_eq!(lane_for_digit(&m, '3'), None);
        let rows = pick_rows(&m);
        let words: Vec<&str> = rows.iter().map(|(_, w)| *w).collect();
        assert_eq!(words, ["Doing", "Unsorted", "cancel"]);
    }

    #[test]
    fn offers_only_the_first_nine_lanes_one_digit_each() {
        let mut core = cockpit_core::app::Model {
            data: Some(cockpit_core::Data::default()),
            ..Default::default()
        };
        let ten: Vec<cockpit_core::lanes::LaneConfig> = (1..=10)
            .map(|n| cockpit_core::lanes::LaneConfig {
                name: format!("L{n}"),
                ..Default::default()
            })
            .collect();
        core.session.set_lanes(&ten);
        let m = PaneModel::from_core(&mut core);
        assert_eq!(m.lane_picks.len(), 11, "ten lanes and Unsorted");
        let rows = pick_rows(&m);
        let words: Vec<&str> = rows.iter().map(|(_, w)| *w).collect();
        assert_eq!(
            words,
            [
                "L1", "L2", "L3", "L4", "L5", "L6", "L7", "L8", "L9", "cancel"
            ]
        );
        assert_eq!(rows.get(8).map(|(d, _)| d.as_str()), Some("9"));
        assert_eq!(lane_for_digit(&m, '9'), Some(LaneKey::from("L9")));
        assert_eq!(lane_for_digit(&m, '0'), None);
    }

    #[test]
    fn keeps_a_keys_boxs_last_row_when_the_pane_is_short() {
        let rows = [1, 2, 3, 4];
        assert_eq!(fit_rows(&rows, 9), [1, 2, 3, 4]);
        assert_eq!(fit_rows(&rows, 3), [1, 2, 4]);
        assert_eq!(fit_rows(&rows, 1), [4]);
        assert!(fit_rows(&rows, 0).is_empty());
    }

    /// Card "n" waiting in Main, card "w" waiting in Parked, and folded
    /// Review, whose waiting card the pane does not show.
    fn walked() -> PaneModel {
        use fixtures::{card, lane};
        PaneModel {
            needs: Needs {
                count: 3,
                ..Needs::default()
            },
            lanes: vec![
                lane(
                    LaneKey::from("main"),
                    vec![card("n", 0, true), card("a", 2, false)],
                ),
                lane(LaneKey::from("review"), Vec::new()),
                lane(LaneKey::from("parked"), vec![card("w", 0, true)]),
            ],
            ..PaneModel::default()
        }
    }

    #[test]
    fn walks_the_lanes_cards_waiting_or_not() {
        assert_eq!(walked().card_ids(), ["n", "a", "w"]);
    }

    #[test]
    fn knows_who_waits_and_which_lane_holds_each_card() {
        let m = walked();
        assert!(m.is_waiting("n"));
        assert!(m.is_waiting("w"));
        assert!(!m.is_waiting("a"));
        assert!(!m.is_waiting("f"), "in a folded lane, so not on screen");
        assert_eq!(m.lane_of("n"), Some(LaneKey::from("main")));
        assert_eq!(m.lane_of("f"), None);
        assert_eq!(m.lane_of("w"), Some(LaneKey::from("parked")));
        assert_eq!(m.lane_of("z"), None);
        let main: Vec<&str> = m
            .lane_rows(&LaneKey::from("main"))
            .into_iter()
            .map(Row::ws_id)
            .collect();
        assert_eq!(main, ["n", "a"]);
        assert!(m.lane_rows(&LaneKey::from("review")).is_empty());
    }
}

/// Small rows and lanes for the pane's unit tests.
#[cfg(test)]
pub(crate) mod fixtures {
    use super::*;

    /// A card with `id` as its title, in state `rank`, waiting on Jon
    /// (Your turn's clay) when `waiting`.
    pub fn card(id: &str, rank: u8, waiting: bool) -> Row {
        Row::Card(Box::new(Card {
            ws_id: id.into(),
            icon: Icon {
                glyph: DOT,
                ink: None,
            },
            title: id.into(),
            density: Density::Full,
            badge: Badge {
                icon: "terminal".into(),
                color: None,
            },
            unread: String::new(),
            ready: false,
            pinned: false,
            progress: None,
            helpers: String::new(),
            status: String::new(),
            status_ink: Token::MetaText,
            age: String::new(),
            status_has_age: false,
            left_off: String::new(),
            chips: Vec::new(),
            row_pr: None,
            detail: String::new(),
            detail_ink: Token::Secondary,
            detail_lines: 1,
            waiting: waiting.then_some(Waiting {
                edge: Token::Clay,
                ink: Token::ClayText,
            }),
            rank,
            movable: true,
            dimmed: false,
            selected: false,
            menu: Vec::new(),
        }))
    }

    /// An open lane holding `rows`.
    pub fn lane(key: LaneKey, rows: Vec<Row>) -> Lane {
        Lane {
            name: key.as_str().into(),
            key,
            empty: rows.is_empty(),
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
}
