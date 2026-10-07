//! What the pane draws: the core's panel model (cockpit_core::panel),
//! built once per frame from the core, with the words only the terminal
//! draws (its keys overlay and lane picker) and the cut-word check's list.

pub use cockpit_core::panel::*;
pub use cockpit_core::panel::{Panel as PaneModel, PanelView as PaneView};

/// The keys the `?` overlay lists: the key, then what it does.
pub const KEYS: [(&str, &str); 18] = [
    ("↑ ↓", "move between cards"),
    ("shift ↑ ↓", "reorder in its lane"),
    ("m 1-5", "move to a lane"),
    ("drag", "move to a lane or spot"),
    ("Enter", "switch to it"),
    ("d", "dismiss from Needs you"),
    ("r", "send to For review"),
    ("p", "park a merged card"),
    ("x", "close a merged card"),
    ("k", "keep: hide its buttons"),
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

/// The lane a digit picks after `m`: 1 is the first lane, in display order.
pub fn lane_for_digit(c: char) -> Option<LaneKey> {
    let n = c.to_digit(10)?;
    let i = usize::try_from(n).ok()?.checked_sub(1)?;
    LANES.get(i).map(|l| l.key)
}

/// The lane picker's rows: each digit and the lane it picks, then Esc.
pub fn pick_rows() -> Vec<(String, &'static str)> {
    let mut rows: Vec<(String, &'static str)> = LANES
        .iter()
        .enumerate()
        .map(|(i, l)| ((i + 1).to_string(), l.name))
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
        NEEDS_LABEL,
        OLDEST_WORD,
        GHOST_GAP,
        KEYS_TITLE,
        PICK_TITLE,
        PICK_CANCEL.0,
        PICK_CANCEL.1,
        DROP_HERE,
        DROP_AT_END,
        TO_REVIEW,
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
    for (key, what) in pick_rows() {
        out.push(key);
        out.push(what.to_string());
    }
    if let NextLine::Step { title, place, .. } = &model.next {
        out.push(title.clone());
        out.push(place.clone());
    }
    out.push(model.needs.count.to_string());
    out.push(model.needs.wait.clone());
    out.push(model.needs.more.clone());
    for r in &model.needs.rows {
        out.push(r.title.clone());
        out.push(r.line.clone());
    }
    for lane in &model.lanes {
        out.push(lane.name.clone());
        out.push(lane.count.to_string());
        if let Some(a) = &lane.anchor {
            out.push(a.unread.clone());
        }
        out.push(lane.merge_ready.clone());
        for row in &lane.rows {
            match row {
                Row::Card(c) => card_words(c, &mut out),
                Row::Ghost { title, text, .. } => {
                    out.push(title.clone());
                    out.push(text.clone());
                }
            }
        }
    }
    for row in &model.projects {
        match row {
            ProjectRow::Header(h) => {
                out.push(h.name.clone());
                out.push(h.count.to_string());
            }
            ProjectRow::Card(c) => card_words(c, &mut out),
            ProjectRow::Ghost { title, text, .. } => {
                out.push(title.clone());
                out.push(text.clone());
            }
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
    out.push(c.left_off.clone());
    out.push(c.detail.clone());
    for chip in c.chips.iter().chain(&c.merged) {
        out.extend(chip.pieces.iter().map(|p| p.text.clone()));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn picks_lanes_by_digit_in_display_order() {
        assert_eq!(lane_for_digit('1'), Some(LaneKey::Main));
        assert_eq!(lane_for_digit('4'), Some(LaneKey::Parked));
        assert_eq!(lane_for_digit('5'), Some(LaneKey::Unsorted));
        assert_eq!(lane_for_digit('0'), None);
        assert_eq!(lane_for_digit('6'), None);
        assert_eq!(lane_for_digit('m'), None);
        let rows = pick_rows();
        assert_eq!(rows.first(), Some(&("1".to_string(), "Main activity")));
        assert_eq!(rows.last(), Some(&("Esc".to_string(), "cancel")));
    }

    #[test]
    fn keeps_a_keys_boxs_last_row_when_the_pane_is_short() {
        let rows = [1, 2, 3, 4];
        assert_eq!(fit_rows(&rows, 9), [1, 2, 3, 4]);
        assert_eq!(fit_rows(&rows, 3), [1, 2, 4]);
        assert_eq!(fit_rows(&rows, 1), [4]);
        assert!(fit_rows(&rows, 0).is_empty());
    }

    /// Card "f" waiting in Needs you with its card filed in folded Review.
    fn walked() -> PaneModel {
        use fixtures::{card, ghost, lane, needs_row};
        PaneModel {
            needs: Needs {
                count: 3,
                rows: vec![
                    needs_row("n", Some(LaneKey::Main)),
                    needs_row("f", Some(LaneKey::Review)),
                ],
                ..Needs::default()
            },
            lanes: vec![
                lane(LaneKey::Main, vec![ghost("n", 0), card("a", 2, false)]),
                lane(LaneKey::Review, Vec::new()),
                lane(LaneKey::Parked, vec![card("w", 0, true)]),
            ],
            ..PaneModel::default()
        }
    }

    #[test]
    fn walks_the_strip_then_the_lanes_cards() {
        assert_eq!(walked().card_ids(), ["n", "f", "a", "w"]);
    }

    #[test]
    fn knows_who_waits_and_which_lane_holds_each_card() {
        let m = walked();
        assert!(m.in_strip("n"));
        assert!(!m.in_strip("w"));
        assert!(m.is_waiting("n"));
        assert!(m.is_waiting("w"), "past the cap");
        assert!(!m.is_waiting("a"));
        assert_eq!(m.lane_of("n"), Some(LaneKey::Main), "by its placeholder");
        assert_eq!(
            m.lane_of("f"),
            Some(LaneKey::Review),
            "filed in a folded lane"
        );
        assert_eq!(m.lane_of("w"), Some(LaneKey::Parked));
        assert_eq!(m.lane_of("z"), None);
        let main: Vec<&str> = m
            .lane_rows(LaneKey::Main)
            .into_iter()
            .map(Row::ws_id)
            .collect();
        assert_eq!(main, ["n", "a"]);
        assert!(m.lane_rows(LaneKey::Review).is_empty());
    }
}

/// Small rows, lanes and strip rows for the pane's unit tests.
#[cfg(test)]
pub(crate) mod fixtures {
    use super::*;

    /// A card with `id` as its title, in state `rank`.
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
            merged: Vec::new(),
            detail: String::new(),
            detail_lines: 1,
            waiting,
            rank,
            movable: true,
            dimmed: false,
            selected: false,
            menu: Vec::new(),
        }))
    }

    /// A placeholder for `id`.
    pub fn ghost(id: &str, rank: u8) -> Row {
        Row::Ghost {
            ws_id: id.into(),
            title: id.into(),
            text: "your turn".into(),
            rank,
        }
    }

    /// An open lane holding `rows`.
    pub fn lane(key: LaneKey, rows: Vec<Row>) -> Lane {
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

    /// A Needs you row for `id`, its card filed in `lane`.
    pub fn needs_row(id: &str, lane: Option<LaneKey>) -> NeedsRow {
        NeedsRow {
            ws_id: id.into(),
            icon: Icon {
                glyph: DOT,
                ink: None,
            },
            title: id.into(),
            line: String::new(),
            ink: Token::ClayText,
            lane,
            movable: true,
        }
    }
}
