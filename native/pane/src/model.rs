//! What the pane draws, worked out once per frame from the core: every
//! word and colour token the views need, so the views only lay them out.
//!
//! The core's view model names workspaces by id; a card's title, status
//! and detail come from the core's session reads, which take the frame's
//! data and tidy the session as they go. So the pane builds its model from
//! the core's whole `Model`, not the view model alone.

use cockpit_core::Model;
use cockpit_core::app::{LaneHeaderView, ViewModel};
use cockpit_core::by_project::ProjectEntry;
use cockpit_core::card_chips::Chip as CoreChip;
use cockpit_core::data::{Data, Workspace};
use cockpit_core::lane_entries::{LaneEntry, shows_left_off};
use cockpit_core::lanes::{Density, LANES, LaneKey};
use cockpit_core::menu::MenuView;
use cockpit_core::model::card_density;
use cockpit_core::moves::MoveSize;
use cockpit_core::persist::ViewMode;
use cockpit_core::placement::is_foreign_anchor;
use cockpit_core::pr_colors::{pr_ink, pr_text_color};
use cockpit_core::prs::pr_summary;
use cockpit_core::session::Session;
use cockpit_core::status::StatusStyle;
use cockpit_core::theme::Token;
use cockpit_core::ui::PillColors;

use cockpit_core::status::DETAIL_MAX;

use crate::editor::EditorView;
use crate::text::whole_words;
use crate::theme;

/// The core's caps on a Needs you row's detail and the left-off prompt
/// (status.rs `needs_detail` and `LEFT_OFF_MAX`, private there), so a cut
/// at the cap can be taken back to a whole word.
const NEEDS_DETAIL_MAX: usize = 80;
const LEFT_OFF_MAX: usize = 90;
/// Before the left-off prompt (words.rs `YOU_WORD` and its colon).
const LEFT_OFF_LEAD: &str = "You: ";

/// The view switch's two views.
pub const ALL_LABEL: &str = "All";
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
pub const KEYS: [(&str, &str); 15] = [
    ("↑ ↓", "move between cards"),
    ("shift ↑ ↓", "reorder in its lane"),
    ("m 1-5", "move to a lane"),
    ("drag", "move to a lane or spot"),
    ("Enter", "switch to it"),
    ("d", "dismiss from Needs you"),
    ("r", "send to For review"),
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
/// A card's To review action, as the sidebar words it.
pub const TO_REVIEW: &str = "To review →";
/// After a branch with uncommitted changes.
pub const DIRTY_MARK: &str = "●";
/// The row under the busy projects, as the sidebar's "+ New project".
pub const NEW_PROJECT_LABEL: &str = "+ New project";
/// The cursor's ids for a project's header, a quiet row and "+ New project".
pub const PROJECT_ROW: &str = "p:";
pub const QUIET_ROW: &str = "q:";
pub const NEW_ROW: &str = "new";
/// The heading over the projects with no sessions.
pub const QUIET_LABEL: &str = "Quiet";
/// On a project that has a folder to open a session in.
pub const PLUS_MARK: &str = "+";
/// On the header of the lane a drag would drop into: above a card in it,
/// or at its end.
pub const DROP_HERE: &str = "drop here";
pub const DROP_AT_END: &str = "drop at the end";
/// In the margin of the card a drag would land above.
pub const DROP_MARK: &str = "▔";

/// Which view the pane draws, as the core has it; Tab asks the core to
/// flip it.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum PaneView {
    #[default]
    All,
    Projects,
}

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
    /// The lane its card is filed in, drawn or not (a folded lane draws
    /// no rows).
    pub lane: Option<LaneKey>,
    /// Whether the core will move it: not when it anchors another group.
    pub movable: bool,
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
    /// Its chips row: the size, the PR, the branch, the ports and its
    /// actions, as the sidebar's card of this kind shows them; empty for
    /// a row.
    pub chips: Vec<Chip>,
    /// The latest message, or what the waiting chat wants.
    pub detail: String,
    /// How many detail lines it draws: two on a full card, else one.
    pub detail_lines: usize,
    /// Its session waits in Needs you, past the strip's cap.
    pub waiting: bool,
    /// Its state's place in the lane's sort (the core's state rank): a
    /// lane sorts by state, and a card keeps its place only among cards
    /// in its own state.
    pub rank: u8,
    /// Whether the core will move it: a card that anchors another cmux
    /// group is that group, so it stays put (drop.ts isForeignAnchor).
    pub movable: bool,
}

/// A run of a chip's words in one ink.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Piece {
    pub text: String,
    pub ink: Token,
}

/// One chip: its pieces, a space apart.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Chip {
    pub pieces: Vec<Piece>,
    /// It goes first when the line is too narrow: the branch, as the
    /// sidebar's branch chip gives way to the PR, ports and actions.
    pub gives_way: bool,
}

impl Chip {
    fn of(pieces: Vec<Piece>) -> Chip {
        Chip {
            pieces,
            gives_way: false,
        }
    }
}

fn piece(text: impl Into<String>, ink: Token) -> Piece {
    Piece {
        text: text.into(),
        ink,
    }
}

/// The size chip's ink: the state ink that fits what answering takes.
pub fn size_ink(size: MoveSize) -> Token {
    match size {
        MoveSize::Quick => Token::GreenText,
        MoveSize::Decide => Token::ClayText,
        MoveSize::Review => Token::BlueText,
    }
}

/// A core chip as the pane draws it: the PR's number in the quiet chip's
/// ink, its state in its health's and its diff size faint; the branch with
/// its dirty dot, and the ports, in the quiet chip's ink.
pub fn chip_view(c: &CoreChip) -> Chip {
    let quiet = Token::Secondary;
    let pieces = match c {
        CoreChip::Size { text, size } => vec![piece(text, size_ink(*size))],
        CoreChip::Pr {
            tag,
            state,
            health,
            diff,
            ..
        } => {
            let mut out = vec![piece(tag, quiet)];
            if !state.is_empty() {
                out.push(piece(state, pr_ink(*health)));
            }
            if !diff.is_empty() {
                out.push(piece(diff, Token::Faint));
            }
            out
        }
        CoreChip::Branch { text, dirty } => {
            let mut out = vec![piece(text, quiet)];
            if *dirty {
                out.push(piece(DIRTY_MARK, quiet));
            }
            out
        }
        CoreChip::Port { text, .. } => vec![piece(text, quiet)],
    };
    Chip {
        pieces,
        gives_way: matches!(c, CoreChip::Branch { .. }),
    }
}

/// The To review action: green while its PR is ready to merge.
pub fn review_chip(green: bool) -> Chip {
    let ink = if green {
        Token::GreenDeep
    } else {
        Token::Secondary
    };
    Chip::of(vec![piece(TO_REVIEW, ink)])
}

/// Which card a chips row is for: the sidebar's full card and its
/// Projects card carry a chips row, a compact card its PR in words, and
/// a row none.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChipsFor {
    Full,
    Compact,
    Row,
    Project,
}

/// A row of the Projects view.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProjectRow {
    Header(ProjectHead),
    Card(Card),
    /// A card whose session sits in Needs you: its title and why.
    Ghost {
        ws_id: String,
        title: String,
        text: String,
    },
    /// "+ New project": Enter opens the editor under it.
    NewProject,
    /// The open project editor, under its project's row or "+ New project".
    Editor(EditorView),
    QuietHeader {
        count: usize,
        collapsed: bool,
    },
    /// A project with no sessions: its name, and "+" when it has a folder.
    Quiet {
        /// Its key in the core, and its row's id for the cursor.
        key: String,
        id: String,
        name: String,
        color: Option<u32>,
        can_open: bool,
    },
}

/// What a Projects row the cursor is on stands for.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProjectTarget {
    Card(String),
    /// A project's header or (`quiet`) quiet row: "+" opens a session
    /// when it can.
    Project {
        key: String,
        can_open: bool,
        quiet: bool,
    },
    New,
}

/// A project's header: its name in its own colour's mark, the cards it
/// counts, and "+" when it has a folder.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProjectHead {
    /// Its key in the core, and its row's id for the cursor.
    pub key: String,
    pub id: String,
    pub name: String,
    /// The table's colour; None draws the grey of a dot with no colour.
    pub color: Option<u32>,
    pub count: usize,
    pub pill: PillColors,
    /// While folded: the dot of its most urgent session.
    pub dot: Option<Icon>,
    pub collapsed: bool,
    pub can_open: bool,
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
        /// As a card's: a placeholder is its card, waiting.
        rank: u8,
    },
}

impl Row {
    /// The workspace the row stands for.
    pub fn ws_id(&self) -> &str {
        match self {
            Row::Card(c) => &c.ws_id,
            Row::Ghost { ws_id, .. } => ws_id,
        }
    }

    /// Its state's place in the lane's sort.
    pub fn rank(&self) -> u8 {
        match self {
            Row::Card(c) => c.rank,
            Row::Ghost { rank, .. } => *rank,
        }
    }
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
    /// Which view the core has on: Tab asks it to flip.
    pub view: PaneView,
    pub next: NextLine,
    pub needs: Needs,
    pub lanes: Vec<Lane>,
    /// The Projects view's rows; empty while All is on.
    pub projects: Vec<ProjectRow>,
    /// The open card or project menu, with its items' words for this frame.
    pub menu: Option<MenuView>,
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
            None => PaneModel {
                view: view_of(view),
                ..PaneModel::default()
            },
        }
    }

    /// The rows the cursor moves between in Projects, top to bottom: each
    /// project's header, its cards by workspace id, "+ New project" and
    /// each quiet project.
    pub fn project_ids(&self) -> Vec<&str> {
        self.projects
            .iter()
            .filter_map(|r| match r {
                ProjectRow::Header(h) => Some(h.id.as_str()),
                ProjectRow::Card(c) => Some(c.ws_id.as_str()),
                ProjectRow::NewProject => Some(NEW_ROW),
                ProjectRow::Quiet { id, .. } => Some(id.as_str()),
                ProjectRow::Ghost { .. }
                | ProjectRow::QuietHeader { .. }
                | ProjectRow::Editor(_) => None,
            })
            .collect()
    }

    /// What the Projects row with cursor id `id` stands for.
    pub fn project_target(&self, id: &str) -> Option<ProjectTarget> {
        self.projects.iter().find_map(|r| match r {
            ProjectRow::Header(h) if h.id == id => Some(ProjectTarget::Project {
                key: h.key.clone(),
                can_open: h.can_open,
                quiet: false,
            }),
            ProjectRow::Quiet {
                key,
                id: row,
                can_open,
                ..
            } if row == id => Some(ProjectTarget::Project {
                key: key.clone(),
                can_open: *can_open,
                quiet: true,
            }),
            ProjectRow::Card(c) if c.ws_id == id => Some(ProjectTarget::Card(c.ws_id.clone())),
            ProjectRow::NewProject if id == NEW_ROW => Some(ProjectTarget::New),
            _ => None,
        })
    }

    /// The open project editor, while Projects shows one.
    pub fn editor(&self) -> Option<&EditorView> {
        self.projects.iter().find_map(|r| match r {
            ProjectRow::Editor(e) => Some(e),
            _ => None,
        })
    }

    /// The cards the cursor moves between, top to bottom, by workspace id:
    /// the Needs you rows, then the lanes' cards.
    pub fn card_ids(&self) -> Vec<&str> {
        let needs = self.needs.rows.iter().map(|r| r.ws_id.as_str());
        let cards = self
            .lanes
            .iter()
            .flat_map(|l| &l.rows)
            .filter_map(|r| match r {
                Row::Card(c) => Some(c.ws_id.as_str()),
                Row::Ghost { .. } => None,
            });
        needs.chain(cards).collect()
    }

    /// Whether `id` is a row in the Needs you strip.
    pub fn in_strip(&self, id: &str) -> bool {
        self.needs.rows.iter().any(|r| r.ws_id == id)
    }

    /// Whether `id`'s session waits in Needs you: a row in the strip, or a
    /// card past its cap.
    pub fn is_waiting(&self, id: &str) -> bool {
        self.in_strip(id)
            || self
                .lanes
                .iter()
                .flat_map(|l| &l.rows)
                .any(|r| matches!(r, Row::Card(c) if c.ws_id == id && c.waiting))
    }

    /// Whether `id` is a card in a lane, not a placeholder.
    pub fn is_lane_card(&self, id: &str) -> bool {
        self.lanes
            .iter()
            .flat_map(|l| &l.rows)
            .any(|r| matches!(r, Row::Card(c) if c.ws_id == id))
    }

    /// Whether the core will move `id`'s card: false for one that anchors
    /// another group, and for an id the pane does not show.
    pub fn movable(&self, id: &str) -> bool {
        let card = self
            .lanes
            .iter()
            .flat_map(|l| &l.rows)
            .find_map(|r| match r {
                Row::Card(c) if c.ws_id == id => Some(c.movable),
                _ => None,
            });
        let strip = || {
            self.needs
                .rows
                .iter()
                .find(|r| r.ws_id == id)
                .map(|r| r.movable)
        };
        card.or_else(strip).unwrap_or(false)
    }

    /// The lane `id`'s card or placeholder sits in, or for a Needs you
    /// row the lane its card is filed in, even folded.
    pub fn lane_of(&self, id: &str) -> Option<LaneKey> {
        self.lanes
            .iter()
            .find(|l| l.rows.iter().any(|r| r.ws_id() == id))
            .map(|l| l.key)
            .or_else(|| {
                let row = self.needs.rows.iter().find(|r| r.ws_id == id)?;
                row.lane
            })
    }

    /// A lane's rows top to bottom, cards and placeholders. A placeholder
    /// stands for a real tab in its lane (drop.ts), so a card can land
    /// above one.
    pub fn lane_rows(&self, key: LaneKey) -> Vec<&Row> {
        self.lanes
            .iter()
            .filter(|l| l.key == key)
            .flat_map(|l| &l.rows)
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
                    Row::Card(c) => card_words(c, &mut out),
                    Row::Ghost { title, text, .. } => {
                        out.push(title.clone());
                        out.push(text.clone());
                    }
                }
            }
        }
        for row in &self.projects {
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
}

/// A card's words, for `words`.
fn card_words(c: &Card, out: &mut Vec<String>) {
    out.push(c.title.clone());
    out.push(c.status.clone());
    out.push(c.left_off.clone());
    out.push(c.detail.clone());
    for chip in &c.chips {
        out.extend(chip.pieces.iter().map(|p| p.text.clone()));
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

/// The core's view mode as the pane's view; anything but Projects is All.
pub fn view_of(view: &ViewModel) -> PaneView {
    if view.mode == ViewMode::Projects.as_str() {
        PaneView::Projects
    } else {
        PaneView::All
    }
}

fn build(session: &mut Session, data: &Data, view: &ViewModel) -> PaneModel {
    let shown = view_of(view);
    let projects = match shown {
        PaneView::Projects => projects(session, data, view),
        PaneView::All => Vec::new(),
    };
    PaneModel {
        view: shown,
        next: next_line(data, view),
        needs: needs(session, data, view),
        lanes: lanes(session, data, view),
        projects,
        menu: session.menu_view(data),
    }
}

/// A card's chips row, for the kind of card it is.
fn chips_row(
    session: &mut Session,
    data: &Data,
    w: Option<&Workspace>,
    kind: ChipsFor,
) -> Vec<Chip> {
    let mut out: Vec<Chip> = match kind {
        ChipsFor::Row => return Vec::new(),
        // card_chips, so a merged card drops its clean branch as the sidebar does.
        ChipsFor::Full | ChipsFor::Project => session
            .card_chips(data, w, true)
            .iter()
            .map(chip_view)
            .collect(),
        ChipsFor::Compact => compact_pr(session, w).into_iter().collect(),
    };
    if session.can_file_for_review(data, w) {
        out.push(review_chip(session.review_is_green(w)));
    }
    // Only once the shell has said where home is: until then the home
    // folder itself would be offered as a project.
    if kind == ChipsFor::Project && session.home.is_some() && session.can_create_project(w) {
        out.push(Chip::of(vec![piece(
            session.make_project_label(w),
            Token::Secondary,
        )]));
    }
    out
}

/// A compact card's PR in words, "#45 · ready", in its health's ink,
/// then its diff size, faint. The sidebar runs it on from the status
/// line after a "·"; here it has a line of its own, so it has none.
fn compact_pr(session: &Session, w: Option<&Workspace>) -> Option<Chip> {
    let pr = pr_summary(&session.saved, w)?;
    let mut pieces = vec![piece(
        pr.text.clone(),
        pr_text_color(Some(&pr), Token::Secondary),
    )];
    if !pr.diff.is_empty() {
        pieces.push(piece(pr.diff.clone(), Token::Faint));
    }
    Some(Chip::of(pieces))
}

/// Which chips a card in All carries, by its density.
pub fn chips_for_density(d: Density) -> ChipsFor {
    match d {
        Density::Full => ChipsFor::Full,
        Density::Compact => ChipsFor::Compact,
        Density::Row => ChipsFor::Row,
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
                line: needs_line(session, data, w),
                ink: session.needs_ink(w),
                lane: w.map(|w| session.lane_of(data, w)),
                movable: !is_foreign_anchor(session, data, id),
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

/// A Needs you row's line, "Asking: allow git push?", with a detail the
/// core cut taken back to a whole word.
fn needs_line(session: &mut Session, data: &Data, w: Option<&Workspace>) -> String {
    let label = session.status_info(data, w).label;
    let detail = whole_words(&session.needs_detail(w), NEEDS_DETAIL_MAX);
    format!("{label}: {detail}")
}

/// "You: " and the last prompt, with a prompt the core cut taken back to
/// a whole word.
fn left_off(text: &str) -> String {
    match text.strip_prefix(LEFT_OFF_LEAD) {
        Some(prompt) => format!("{LEFT_OFF_LEAD}{}", whole_words(prompt, LEFT_OFF_MAX)),
        None => whole_words(text, 0),
    }
}

fn card(session: &mut Session, data: &Data, view: &ViewModel, id: &str) -> Card {
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
        left_off(&session.left_off_text(w))
    } else {
        String::new()
    };
    let chips = chips_row(session, data, w, chips_for_density(density));
    Card {
        ws_id: id.to_string(),
        icon: icon_of(&style),
        title: title_of(w, id),
        status,
        status_ink,
        left_off,
        chips,
        detail: whole_words(&session.card_detail(w), DETAIL_MAX),
        detail_lines: detail_lines(density),
        waiting: view.needs.list.iter().any(|w| w == id),
        rank: session.state_rank(data, w),
        movable: !is_foreign_anchor(session, data, id),
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
                let c = card(session, data, view, ws_id);
                push_row(&mut out, Row::Card(c));
            }
            LaneEntry::Ghost { ws_id, .. } => {
                let w = data.ws_by_id(ws_id);
                let row = Row::Ghost {
                    ws_id: ws_id.clone(),
                    title: title_of(w, ws_id),
                    text: session.placeholder_text(w),
                    rank: session.state_rank(data, w),
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

/// A card in the Projects view, as the sidebar's project card: its title
/// and status, what a waiting chat wants, and its chips with the branch.
fn project_card(session: &mut Session, data: &Data, view: &ViewModel, id: &str) -> Card {
    let w = data.ws_by_id(id);
    let style = session.status_info(data, w);
    let wanted = session.move_of(w).map(|m| m.text).unwrap_or_default();
    Card {
        ws_id: id.to_string(),
        icon: icon_of(&style),
        title: title_of(w, id),
        status: session.status_line(data, w),
        status_ink: style.text,
        left_off: String::new(),
        chips: chips_row(session, data, w, ChipsFor::Project),
        detail: whole_words(&wanted, 0),
        detail_lines: 2,
        waiting: view.needs.list.iter().any(|w| w == id),
        rank: session.state_rank(data, w),
        movable: !is_foreign_anchor(session, data, id),
    }
}

/// A project's header: its look from the table, and the cards it counts.
fn project_head(session: &mut Session, data: &Data, k: &str) -> ProjectHead {
    let p = session.project_by_key(k);
    let collapsed = session.is_project_collapsed(k);
    let ws = session.project_workspaces(data, k);
    let status = session.header_status(data, &ws, collapsed);
    let dot = status
        .dot
        .map(|w| icon_of(&session.status_info(data, Some(w))));
    ProjectHead {
        key: k.to_string(),
        id: format!("{PROJECT_ROW}{k}"),
        name: p.name.clone(),
        color: theme::parse_hex(&p.color),
        count: ws.len(),
        pill: status.tint,
        dot,
        collapsed,
        can_open: session.can_open_project(k),
    }
}

fn projects(session: &mut Session, data: &Data, view: &ViewModel) -> Vec<ProjectRow> {
    let entries = session.project_entries(data);
    let quiet = session.quiet_projects(data).len();
    let mut out = Vec::new();
    for entry in &entries {
        let row = match entry {
            ProjectEntry::Header { project, .. } => {
                ProjectRow::Header(project_head(session, data, project))
            }
            ProjectEntry::Ws { ws_id, .. } => {
                ProjectRow::Card(project_card(session, data, view, ws_id))
            }
            ProjectEntry::Ghost { ws_id, .. } => {
                let w = data.ws_by_id(ws_id);
                ProjectRow::Ghost {
                    ws_id: ws_id.clone(),
                    title: title_of(w, ws_id),
                    text: session.placeholder_text(w),
                }
            }
            ProjectEntry::NewRow { .. } => ProjectRow::NewProject,
            ProjectEntry::QuietHeader { .. } => ProjectRow::QuietHeader {
                count: quiet,
                collapsed: session.quiet_collapsed(),
            },
            ProjectEntry::QuietRow { project, .. } => {
                let p = session.project_by_key(project);
                ProjectRow::Quiet {
                    key: project.clone(),
                    id: format!("{QUIET_ROW}{project}"),
                    name: p.name.clone(),
                    color: theme::parse_hex(&p.color),
                    can_open: session.can_open_project(project),
                }
            }
            ProjectEntry::Editor { project, .. } => {
                ProjectRow::Editor(EditorView::from_session(session, data, project))
            }
        };
        out.push(row);
    }
    out
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
    fn takes_a_cut_prompt_back_to_a_whole_word() {
        let prompt = format!("{} tail", "word ".repeat(17));
        let cut = format!("{LEFT_OFF_LEAD}{}…", &prompt[..LEFT_OFF_MAX - 1]);
        let got = left_off(&cut);
        assert!(got.ends_with("word…"), "{got}");
        assert_eq!(left_off("You: fix it…"), "You: fix it…");
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

    #[test]
    fn inks_a_prs_number_quietly_its_state_by_health_and_its_diff_faint() {
        use cockpit_core::prs::PrHealth;
        let c = chip_view(&CoreChip::Pr {
            tag: "#3".into(),
            state: "1 failing".into(),
            health: PrHealth::Failing,
            diff: "+1 \u{2212}2".into(),
            url: None,
        });
        let inks: Vec<(&str, Token)> = c.pieces.iter().map(|p| (p.text.as_str(), p.ink)).collect();
        assert_eq!(
            inks,
            [
                ("#3", Token::Secondary),
                ("1 failing", Token::RedText),
                ("+1 \u{2212}2", Token::Faint)
            ]
        );
        let bare = chip_view(&CoreChip::Pr {
            tag: "#6".into(),
            state: String::new(),
            health: PrHealth::Quiet,
            diff: String::new(),
            url: None,
        });
        assert_eq!(bare.pieces.len(), 1, "no state, no diff");
    }

    #[test]
    fn marks_a_dirty_branch_and_inks_a_size_by_what_answering_takes() {
        let br = chip_view(&CoreChip::Branch {
            text: "feat".into(),
            dirty: true,
        });
        let words: Vec<&str> = br.pieces.iter().map(|p| p.text.as_str()).collect();
        assert_eq!(words, ["feat", DIRTY_MARK]);
        assert!(br.gives_way, "the branch goes first on a narrow line");
        let size = chip_view(&CoreChip::Size {
            text: "Decide".into(),
            size: MoveSize::Decide,
        });
        assert_eq!(size.pieces[0].ink, Token::ClayText);
        assert_eq!(size_ink(MoveSize::Quick), Token::GreenText);
        assert_eq!(size_ink(MoveSize::Review), Token::BlueText);
        let port = chip_view(&CoreChip::Port {
            text: ":5173 \u{2197}".into(),
            url: "http://localhost:5173".into(),
        });
        assert_eq!(port.pieces[0].ink, Token::Secondary);
    }

    #[test]
    fn greens_to_review_only_while_its_pr_is_ready() {
        assert_eq!(review_chip(true).pieces[0].ink, Token::GreenDeep);
        assert_eq!(review_chip(false).pieces[0].ink, Token::Secondary);
        assert_eq!(review_chip(false).pieces[0].text, TO_REVIEW);
    }

    #[test]
    fn gives_a_full_card_its_chips_a_compact_one_its_pr_and_a_row_none() {
        assert_eq!(chips_for_density(Density::Full), ChipsFor::Full);
        assert_eq!(chips_for_density(Density::Compact), ChipsFor::Compact);
        assert_eq!(chips_for_density(Density::Row), ChipsFor::Row);
    }

    #[test]
    fn takes_the_view_from_the_cores_mode() {
        let mut view = ViewModel::default();
        assert_eq!(view_of(&view), PaneView::All, "before any mode");
        view.mode = ViewMode::Projects.as_str().into();
        assert_eq!(view_of(&view), PaneView::Projects);
        view.mode = ViewMode::All.as_str().into();
        assert_eq!(view_of(&view), PaneView::All);
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

    #[test]
    fn files_rows_under_the_lane_headed_last() {
        let mut lanes = Vec::new();
        push_row(&mut lanes, fixtures::ghost("a", 0));
        assert!(lanes.is_empty(), "a row before any header is dropped");
    }
}

/// Small rows, lanes and strip rows for the pane's unit tests.
#[cfg(test)]
pub(crate) mod fixtures {
    use super::*;

    /// A card with `id` as its title, in state `rank`.
    pub fn card(id: &str, rank: u8, waiting: bool) -> Row {
        Row::Card(Card {
            ws_id: id.into(),
            icon: Icon {
                glyph: DOT,
                ink: None,
            },
            title: id.into(),
            status: String::new(),
            status_ink: Token::MetaText,
            left_off: String::new(),
            chips: Vec::new(),
            detail: String::new(),
            detail_lines: 1,
            waiting,
            rank,
            movable: true,
        })
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
