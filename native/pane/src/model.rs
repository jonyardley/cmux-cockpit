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
use cockpit_core::lane_entries::LaneEntry;
use cockpit_core::lanes::{Density, LANES, LaneKey};
use cockpit_core::model::card_density;
use cockpit_core::session::Session;
use cockpit_core::status::StatusStyle;
use cockpit_core::theme::Token;
use cockpit_core::ui::PillColors;

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
/// A folded lane's marker, and an open one's.
pub const FOLDED_MARK: &str = "▸";
pub const OPEN_MARK: &str = "▾";
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

/// The glyph before a title and its colour.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Icon {
    pub glyph: &'static str,
    pub ink: Token,
}

/// Next: where the next press goes, "1 of 5", or nowhere.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NextLine {
    Nothing,
    Step { title: String, place: String },
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
    /// The status and its age, "Working 14m".
    pub status: String,
    pub status_ink: Token,
    /// The latest message, or what the waiting chat wants.
    pub detail: String,
    /// How many detail lines it draws: two full, one compact, none as a row.
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

/// A lane: its header, then its rows (none while folded). An empty lane
/// draws as its header alone, faint and with nothing to fold.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Lane {
    pub key: LaneKey,
    pub empty: bool,
    pub name: &'static str,
    pub marker: Token,
    pub count: usize,
    pub pill: PillColors,
    pub collapsed: bool,
    /// "2 ready to merge", or "".
    pub merge_ready: String,
    pub rows: Vec<Row>,
}

/// Everything the pane draws.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PaneModel {
    pub next: Option<NextLine>,
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
        if let Some(NextLine::Step { title, place }) = &self.next {
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
            out.push(lane.name.to_string());
            out.push(lane.count.to_string());
            out.push(lane.merge_ready.clone());
            for row in &lane.rows {
                match row {
                    Row::Card(c) => {
                        out.push(c.title.clone());
                        out.push(c.status.clone());
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

/// A status's dot: filled, hollow in its ring's colour, or hollow and faint.
pub fn icon_of(style: &StatusStyle) -> Icon {
    match (style.dot, style.ring) {
        (Some(ink), _) => Icon { glyph: DOT, ink },
        (None, Some(ink)) => Icon { glyph: HOLLOW, ink },
        (None, None) => Icon {
            glyph: HOLLOW,
            ink: style.text,
        },
    }
}

/// How many detail lines a card of this density draws.
pub fn detail_lines(d: Density) -> usize {
    match d {
        Density::Full => 2,
        Density::Compact => 1,
        Density::Row => 0,
    }
}

fn build(session: &mut Session, data: &Data, view: &ViewModel) -> PaneModel {
    PaneModel {
        next: Some(next_line(data, view)),
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
                line: session.needs_line(data, w),
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
    Card {
        ws_id: id.to_string(),
        icon: icon_of(&style),
        title: title_of(w, id),
        status: session.status_line(data, w),
        status_ink: style.text,
        detail: session.card_detail(w),
        detail_lines: detail_lines(card_density(data, w)),
    }
}

fn lanes(session: &mut Session, data: &Data, view: &ViewModel) -> Vec<Lane> {
    let mut out: Vec<Lane> = Vec::new();
    for entry in &view.lane_entries {
        match entry {
            LaneEntry::Header { lane, .. } => {
                out.push(lane_head(session, data, *lane, view.lane_headers.get(lane)));
            }
            LaneEntry::Zone { lane, .. } => {
                let head = lane_head(session, data, *lane, view.lane_headers.get(lane));
                out.push(Lane {
                    empty: true,
                    ..head
                });
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

fn lane_head(
    session: &mut Session,
    data: &Data,
    key: LaneKey,
    header: Option<&LaneHeaderView>,
) -> Lane {
    let lane = LANES.iter().find(|l| l.key == key);
    let ids: &[String] = header.map_or(&[], |h| h.workspaces.as_slice());
    let collapsed = header.is_some_and(|h| h.collapsed);
    let ws: Vec<&Workspace> = ids.iter().filter_map(|id| data.ws_by_id(id)).collect();
    let status = session.header_status(data, &ws, collapsed);
    Lane {
        key,
        empty: false,
        name: lane.map_or("", |l| l.name),
        marker: lane.map_or(Token::LaneUnsorted, |l| l.color),
        count: ids.len(),
        pill: status.tint,
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
    fn draws_a_filled_dot_a_ring_or_a_faint_hollow_dot() {
        assert_eq!(
            icon_of(&style(Some(Token::Blue), None)),
            Icon {
                glyph: DOT,
                ink: Token::Blue
            }
        );
        assert_eq!(
            icon_of(&style(None, Some(Token::Blue))),
            Icon {
                glyph: HOLLOW,
                ink: Token::Blue
            }
        );
        assert_eq!(
            icon_of(&style(None, None)),
            Icon {
                glyph: HOLLOW,
                ink: Token::MetaText
            }
        );
    }

    #[test]
    fn gives_full_cards_two_detail_lines_and_rows_none() {
        assert_eq!(detail_lines(Density::Full), 2);
        assert_eq!(detail_lines(Density::Compact), 1);
        assert_eq!(detail_lines(Density::Row), 0);
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
