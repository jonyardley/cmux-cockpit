//! What the pane draws, worked out once per frame from the core: every
//! word and colour token the views need, so the views only lay them out.
//!
//! The core's view model names workspaces by id; a card's title, status
//! and detail come from the core's session reads, which take the frame's
//! data and tidy the session as they go. So the pane builds its model from
//! the core's whole `Model`, not the view model alone.

use cockpit_core::Model;
use cockpit_core::app::{LaneHeaderView, ViewModel};
use cockpit_core::data::{Data, Workspace};
use cockpit_core::lane_entries::{LaneEntry, shows_left_off};
use cockpit_core::lanes::{Density, LANES, LaneKey};
use cockpit_core::model::card_density;
use cockpit_core::session::Session;
use cockpit_core::status::StatusStyle;
use cockpit_core::theme::Token;
use cockpit_core::ui::PillColors;

use crate::text::whole_words;

/// The view switch's one live view for now.
pub const ALL_LABEL: &str = "All";
/// Shown faint until the Projects view is drawn.
pub const PROJECTS_LABEL: &str = "Projects";
/// The hint at the top right.
pub const KEYS_HINT: &str = "? keys";
/// Before Next's target.
pub const NEXT_LABEL: &str = "Next";
/// Next with nowhere to go.
pub const NEXT_NOTHING: &str = "nothing waiting";
/// The Needs you strip's heading.
pub const NEEDS_LABEL: &str = "Needs you";
/// Before the oldest ask's wait.
pub const OLDEST_WORD: &str = "oldest";
/// Between a placeholder's title and why its card went.
pub const GHOST_GAP: &str = "·";
/// A folded lane's chevron, and an open one's.
pub const FOLDED_MARK: &str = "▸";
pub const OPEN_MARK: &str = "▾";
/// A lane's square marker in its colour.
pub const LANE_MARK: &str = "■";
/// A status dot, a hollow one, and a placeholder's.
pub const DOT: &str = "●";
pub const HOLLOW: &str = "○";
pub const GHOST: &str = "◌";

/// The keys the `?` overlay lists: the key, then what it does.
pub const KEYS: [(&str, &str); 4] = [
    ("↑ ↓", "move between cards"),
    ("?", "show or hide the keys"),
    ("q", "quit"),
    ("Esc", "close this"),
];
/// The overlay's title.
pub const KEYS_TITLE: &str = "Keys";

/// The glyph before a title and its colour; None is the grey outline the
/// sidebar draws round a dot with no colour of its own.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Icon {
    pub glyph: &'static str,
    pub ink: Option<Token>,
}

/// Next: where the next press goes, "1 of 5", or nowhere.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub enum NextLine {
    #[default]
    Nothing,
    Step {
        title: String,
        place: String,
    },
}

/// One session in the Needs you strip.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NeedsRow {
    pub ws_id: String,
    pub icon: Icon,
    pub title: String,
    /// "Asking: allow git push?"
    pub line: String,
    pub ink: Token,
}

/// The Needs you strip; empty when nothing waits.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Needs {
    pub count: usize,
    /// "oldest 12m", or "" with nothing timed.
    pub wait: String,
    pub late: bool,
    pub rows: Vec<NeedsRow>,
    /// "+2 more", or "".
    pub more: String,
}

/// A workspace's card.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Card {
    pub ws_id: String,
    pub icon: Icon,
    pub title: String,
    /// The status and its age, "Working 14m"; a row's age alone.
    pub status: String,
    pub status_ink: Token,
    /// "You: " and the last prompt, in lanes you come back to; else "".
    pub left_off: String,
    /// The latest message, or what the waiting chat wants.
    pub detail: String,
    /// How many detail lines it draws: two on a full card, else one.
    pub detail_lines: usize,
}

/// A row under a lane header.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Row {
    Card(Card),
    /// A card whose session sits in Needs you: its title and why.
    Ghost {
        ws_id: String,
        title: String,
        text: String,
    },
}

/// A lane's generated anchor on its header: its dot and unread count.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Anchor {
    pub icon: Icon,
    /// "3", or "" with nothing unread.
    pub unread: String,
}

/// A lane: its header, then its rows (none while folded). An empty lane
/// draws as its header alone, faint and with nothing to fold.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Lane {
    pub key: LaneKey,
    pub empty: bool,
    /// Upper case, as the sidebar's heading.
    pub name: String,
    /// Parked's name and an empty lane's are faint.
    pub faint: bool,
    pub marker: Token,
    pub anchor: Option<Anchor>,
    pub count: usize,
    pub pill: PillColors,
    /// While folded: the dot of its most urgent session.
    pub dot: Option<Icon>,
    pub collapsed: bool,
    /// "2 ready to merge", or "".
    pub merge_ready: String,
    pub rows: Vec<Row>,
}

/// Everything the pane draws.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PaneModel {
    pub next: NextLine,
    pub needs: Needs,
    pub lanes: Vec<Lane>,
}

impl PaneModel {
    /// The pane's model for the core's current frame. With no frame yet,
    /// only the lanes' frame of headers is unknown, so the pane is empty.
    pub fn from_core(core: &mut Model) -> PaneModel {
        let Model {
            session,
            data,
            view,
        } = core;
        match data {
            Some(data) => build(session, data, view),
            None => PaneModel::default(),
        }
    }

    /// The cards the cursor moves between, top to bottom, by workspace id.
    pub fn card_ids(&self) -> Vec<&str> {
        self.lanes
            .iter()
            .flat_map(|l| &l.rows)
            .filter_map(|r| match r {
                Row::Card(c) => Some(c.ws_id.as_str()),
                _ => None,
            })
            .collect()
    }

    /// Every piece of text the pane can draw, for the test that checks no
    /// word is cut.
    pub fn words(&self) -> Vec<String> {
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
        ]
        .iter()
        .map(|s| (*s).to_string())
        .collect();
        for (key, what) in KEYS {
            out.push(key.to_string());
            out.push(what.to_string());
        }
        if let NextLine::Step { title, place } = &self.next {
            out.push(title.clone());
            out.push(place.clone());
        }
        out.push(self.needs.count.to_string());
        out.push(self.needs.wait.clone());
        out.push(self.needs.more.clone());
        for r in &self.needs.rows {
            out.push(r.title.clone());
            out.push(r.line.clone());
        }
        for lane in &self.lanes {
            out.push(lane.name.clone());
            out.push(lane.count.to_string());
            if let Some(a) = &lane.anchor {
                out.push(a.unread.clone());
            }
            out.push(lane.merge_ready.clone());
            for row in &lane.rows {
                match row {
                    Row::Card(c) => {
                        out.push(c.title.clone());
                        out.push(c.status.clone());
                        out.push(c.left_off.clone());
                        out.push(c.detail.clone());
                    }
                    Row::Ghost { title, text, .. } => {
                        out.push(title.clone());
                        out.push(text.clone());
                    }
                }
            }
        }
        out
    }
}

/// A workspace's title as the pane shows it: its own, else its id.
fn title_of(w: Option<&Workspace>, id: &str) -> String {
    let title = w.and_then(|w| w.title.as_deref()).unwrap_or_default();
    let title = title.split_whitespace().collect::<Vec<_>>().join(" ");
    if title.is_empty() {
        id.to_string()
    } else {
        title
    }
}

/// A status's dot: filled, hollow in its ring's colour, or a grey outline.
pub fn icon_of(style: &StatusStyle) -> Icon {
    match (style.dot, style.ring) {
        (Some(ink), _) => Icon {
            glyph: DOT,
            ink: Some(ink),
        },
        (None, ring) => Icon {
            glyph: HOLLOW,
            ink: ring,
        },
    }
}

/// How many detail lines a card of this density draws: two on a full
/// card, one on a compact card or a row (cards.ts detailLine).
pub fn detail_lines(d: Density) -> usize {
    match d {
        Density::Full => 2,
        Density::Compact | Density::Row => 1,
    }
}

/// A lane's heading words: its name in upper case.
pub fn lane_name(name: &str) -> String {
    name.to_uppercase()
}

/// Parked's heading is faint, as is every empty lane's (headers.ts).
pub fn faint_heading(key: LaneKey, empty: bool) -> bool {
    empty || key == LaneKey::Parked
}

/// An unread count as words: "" with none.
pub fn unread_text(n: Option<f64>) -> String {
    match n {
        Some(n) if n.is_finite() && n >= 1.0 => format!("{}", n.trunc()),
        _ => String::new(),
    }
}

fn build(session: &mut Session, data: &Data, view: &ViewModel) -> PaneModel {
    PaneModel {
        next: next_line(data, view),
        needs: needs(session, data, view),
        lanes: lanes(session, data, view),
    }
}

fn next_line(data: &Data, view: &ViewModel) -> NextLine {
    match &view.next.step {
        Some(step) => NextLine::Step {
            title: title_of(data.ws_by_id(&step.target), &step.target),
            place: format!("{} of {}", step.position, step.total),
        },
        None => NextLine::Nothing,
    }
}

fn needs(session: &mut Session, data: &Data, view: &ViewModel) -> Needs {
    let n = &view.needs;
    let rows = n
        .shown
        .iter()
        .map(|id| {
            let w = data.ws_by_id(id);
            let style = session.status_info(data, w);
            NeedsRow {
                ws_id: id.clone(),
                icon: icon_of(&style),
                title: title_of(w, id),
                line: whole_words(&session.needs_line(data, w)),
                ink: session.needs_ink(w),
            }
        })
        .collect();
    Needs {
        count: n.list.len(),
        wait: if n.wait_text.is_empty() {
            String::new()
        } else {
            format!("{OLDEST_WORD} {}", n.wait_text)
        },
        late: n.late,
        rows,
        more: if n.more > 0 {
            format!("+{} more", n.more)
        } else {
            String::new()
        },
    }
}

fn card(session: &mut Session, data: &Data, id: &str) -> Card {
    let w = data.ws_by_id(id);
    let style = session.status_info(data, w);
    let density = card_density(data, w);
    // A row carries its age alone, as the sidebar's row does; a card says
    // its status with the age.
    let (status, status_ink) = if density == Density::Row {
        (session.age_of(data, w), Token::MetaText)
    } else {
        (session.status_line(data, w), style.text)
    };
    let left_off = if shows_left_off(data, w) {
        whole_words(&session.left_off_text(w))
    } else {
        String::new()
    };
    Card {
        ws_id: id.to_string(),
        icon: icon_of(&style),
        title: title_of(w, id),
        status,
        status_ink,
        left_off,
        detail: whole_words(&session.card_detail(w)),
        detail_lines: detail_lines(density),
    }
}

fn lanes(session: &mut Session, data: &Data, view: &ViewModel) -> Vec<Lane> {
    let mut out: Vec<Lane> = Vec::new();
    for entry in &view.lane_entries {
        match entry {
            LaneEntry::Header {
                lane, anchor_id, ..
            } => {
                let header = view.lane_headers.get(lane);
                let mut head = lane_head(session, data, *lane, header, false);
                head.anchor = anchor_id.as_deref().map(|id| anchor(session, data, id));
                out.push(head);
            }
            LaneEntry::Zone { lane, .. } => {
                let header = view.lane_headers.get(lane);
                out.push(lane_head(session, data, *lane, header, true));
            }
            LaneEntry::Ws { ws_id, .. } => {
                let c = card(session, data, ws_id);
                push_row(&mut out, Row::Card(c));
            }
            LaneEntry::Ghost { ws_id, .. } => {
                let w = data.ws_by_id(ws_id);
                let row = Row::Ghost {
                    ws_id: ws_id.clone(),
                    title: title_of(w, ws_id),
                    text: session.placeholder_text(w),
                };
                push_row(&mut out, row);
            }
        }
    }
    out
}

/// Adds a row to the lane last headed; the core always heads a lane first.
fn push_row(lanes: &mut [Lane], row: Row) {
    if let Some(lane) = lanes.last_mut() {
        lane.rows.push(row);
    }
}

/// A generated anchor's dot and unread count, for its lane's header.
fn anchor(session: &mut Session, data: &Data, id: &str) -> Anchor {
    let w = data.ws_by_id(id);
    Anchor {
        icon: icon_of(&session.status_info(data, w)),
        unread: unread_text(w.and_then(|w| w.unread)),
    }
}

fn lane_head(
    session: &mut Session,
    data: &Data,
    key: LaneKey,
    header: Option<&LaneHeaderView>,
    empty: bool,
) -> Lane {
    let lane = LANES.iter().find(|l| l.key == key);
    let ids: &[String] = header.map_or(&[], |h| h.workspaces.as_slice());
    let collapsed = header.is_some_and(|h| h.collapsed);
    let ws: Vec<&Workspace> = ids.iter().filter_map(|id| data.ws_by_id(id)).collect();
    let status = session.header_status(data, &ws, collapsed);
    let dot = status
        .dot
        .map(|w| icon_of(&session.status_info(data, Some(w))));
    Lane {
        key,
        empty,
        name: lane_name(lane.map_or("", |l| l.name)),
        faint: faint_heading(key, empty),
        marker: lane.map_or(Token::LaneUnsorted, |l| l.color),
        anchor: None,
        count: ids.len(),
        pill: status.tint,
        dot,
        collapsed,
        merge_ready: header.map(|h| h.merge_ready.clone()).unwrap_or_default(),
        rows: Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use cockpit_core::ui::Urgency;

    fn style(dot: Option<Token>, ring: Option<Token>) -> StatusStyle {
        StatusStyle {
            label: "Working",
            dot,
            halo: Token::Clear,
            text: Token::MetaText,
            ring,
            urgency: Urgency::Quiet,
        }
    }

    #[test]
    fn draws_a_filled_dot_a_ring_or_a_grey_outline() {
        assert_eq!(
            icon_of(&style(Some(Token::Blue), None)),
            Icon {
                glyph: DOT,
                ink: Some(Token::Blue)
            }
        );
        assert_eq!(
            icon_of(&style(None, Some(Token::Blue))),
            Icon {
                glyph: HOLLOW,
                ink: Some(Token::Blue)
            }
        );
        assert_eq!(
            icon_of(&style(None, None)),
            Icon {
                glyph: HOLLOW,
                ink: None
            }
        );
    }

    #[test]
    fn gives_full_cards_two_detail_lines_and_the_rest_one() {
        assert_eq!(detail_lines(Density::Full), 2);
        assert_eq!(detail_lines(Density::Compact), 1);
        assert_eq!(detail_lines(Density::Row), 1);
    }

    #[test]
    fn heads_a_lane_in_upper_case_and_fades_parked_and_empty_lanes() {
        assert_eq!(lane_name("Main activity"), "MAIN ACTIVITY");
        assert!(faint_heading(LaneKey::Parked, false));
        assert!(faint_heading(LaneKey::Main, true));
        assert!(!faint_heading(LaneKey::Main, false));
    }

    #[test]
    fn says_an_unread_count_only_when_there_is_one() {
        assert_eq!(unread_text(None), "");
        assert_eq!(unread_text(Some(0.0)), "");
        assert_eq!(unread_text(Some(f64::NAN)), "");
        assert_eq!(unread_text(Some(3.0)), "3");
    }

    #[test]
    fn titles_a_workspace_by_its_id_when_it_has_no_title() {
        assert_eq!(title_of(None, "ws-1"), "ws-1");
        let w = Workspace {
            title: Some("  fix   login ".into()),
            ..Workspace::default()
        };
        assert_eq!(title_of(Some(&w), "ws-1"), "fix login");
    }

    #[test]
    fn is_empty_before_the_first_frame() {
        let mut core = Model::default();
        assert_eq!(PaneModel::from_core(&mut core), PaneModel::default());
    }

    #[test]
    fn files_rows_under_the_lane_headed_last() {
        let mut lanes = Vec::new();
        let row = Row::Ghost {
            ws_id: "a".into(),
            title: "a".into(),
            text: "your turn".into(),
        };
        push_row(&mut lanes, row);
        assert!(lanes.is_empty(), "a row before any header is dropped");
    }
}
