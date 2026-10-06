//! The panel model: everything a shell draws of the cockpit, worked out
//! once per frame from the core's whole `Model`, every word and colour
//! token the views need, so a view only lays them out. The terminal pane
//! draws it today; the Swift shell will take the same model across the
//! bridge, so it serialises, and native/fixtures/ holds it for each scene.
//!
//! A card's title, status and detail come from the session's reads, which
//! take the frame's data and tidy the session as they go, so the panel is
//! built from the `Model`, not the view model alone (build.rs).

mod build;
mod editor;

use serde::Serialize;

use crate::Model;

pub use build::{
    chip_view, chips_for_density, detail_lines, faint_heading, icon_of, lane_name, review_chip,
    size_ink, unread_text, view_of,
};
pub use editor::{EditorView, Field};

// The vocabulary a shell draws the panel with, so it needs none of the
// core's inner modules.
pub use crate::lanes::{LANES, LaneKey};
pub use crate::menu::{MenuAction, MenuItem, MenuTarget, MenuView};
pub use crate::projects::PROJECT_COLORS;
pub use crate::text::whole_words;
pub use crate::theme::{Token, parse_hex};
pub use crate::ui::{PillColors, QUIET_PILL};

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

/// A card's To review action, as the sidebar words it.
pub const TO_REVIEW: &str = "To review →";
/// A merged card's Park and Close, as the sidebar words them.
pub const PARK: &str = "Park";
pub const CLOSE: &str = "Close";
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

/// Which view the panel draws, as the core has it; Tab asks the core to
/// flip it.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, facet::Facet)]
#[repr(u8)]
pub enum PanelView {
    #[default]
    All,
    Projects,
}

/// The glyph before a title and its colour; None is the grey outline the
/// sidebar draws round a dot with no colour of its own.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, facet::Facet)]
pub struct Icon {
    pub glyph: &'static str,
    pub ink: Option<Token>,
}

/// Next: where the next press goes, "1 of 5", or nowhere.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, facet::Facet)]
#[repr(u8)]
pub enum NextLine {
    #[default]
    Nothing,
    Step {
        title: String,
        place: String,
    },
}

/// One session in the Needs you strip.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, facet::Facet)]
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
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, facet::Facet)]
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
#[derive(Debug, Clone, PartialEq, Eq, Serialize, facet::Facet)]
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
    /// A merged card's Park and Close. The view puts them at the end of
    /// the chips line when every chip fits whole, else on a line of their
    /// own under it, as the sidebar's mergedBelow does, so neither is cut.
    pub merged: Vec<Chip>,
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
    /// Faint, as the sidebar dims a merged card while nothing in it wants
    /// Jon. The view draws it at full strength under the cursor.
    pub dimmed: bool,
    /// cmux's selected workspace, the one open in the terminal: drawn with
    /// the select ink's outline so it is found at a glance (status.ts
    /// outline). A card tapped through the core reads as selected at once.
    pub selected: bool,
    /// Its card menu for this frame, in the core's words and order, so a
    /// shell can show it the moment Jon right-clicks; a pick goes back as
    /// the menu opened on this card, then the item.
    pub menu: Vec<MenuItem>,
}

/// A run of a chip's words in one ink.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, facet::Facet)]
pub struct Piece {
    pub text: String,
    pub ink: Token,
}

/// One chip: its pieces, a space apart.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, facet::Facet)]
pub struct Chip {
    pub pieces: Vec<Piece>,
    /// It goes first when the line is too narrow: the branch, as the
    /// sidebar's branch chip gives way to the PR, ports and actions.
    pub gives_way: bool,
}

impl Chip {
    pub(crate) fn of(pieces: Vec<Piece>) -> Chip {
        Chip {
            pieces,
            gives_way: false,
        }
    }
}

pub(crate) fn piece(text: impl Into<String>, ink: Token) -> Piece {
    Piece {
        text: text.into(),
        ink,
    }
}

/// Which card a chips row is for: the sidebar's full card and its
/// Projects card carry a chips row, a compact card its PR in words, and
/// a row none.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum ChipsFor {
    Full,
    Compact,
    Row,
    Project,
}

/// A row of the Projects view.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, facet::Facet)]
#[repr(u8)]
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
        /// Its right-click menu, in the core's words and order.
        menu: Vec<MenuItem>,
    },
}

/// What a Projects row the cursor is on stands for.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
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
#[derive(Debug, Clone, PartialEq, Eq, Serialize, facet::Facet)]
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
    /// Its right-click menu, in the core's words and order: the sidebar
    /// cannot word it, as the first item reads the project's folder.
    pub menu: Vec<MenuItem>,
}

/// A row under a lane header.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, facet::Facet)]
#[repr(u8)]
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
/// It has no card, so its badge is the click that opens it (headers.ts
/// anchorStatus), shaded while it is cmux's selected workspace.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, facet::Facet)]
pub struct Anchor {
    /// The anchor's workspace, for the badge's click.
    pub id: String,
    pub selected: bool,
    pub icon: Icon,
    /// "3", or "" with nothing unread.
    pub unread: String,
}

/// A lane: its header, then its rows (none while folded). An empty lane
/// draws as its header alone, faint and with nothing to fold.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, facet::Facet)]
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
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, facet::Facet)]
pub struct Panel {
    /// Which view the core has on: Tab asks it to flip.
    pub view: PanelView,
    pub next: NextLine,
    pub needs: Needs,
    pub lanes: Vec<Lane>,
    /// The Projects view's rows; empty while All is on.
    pub projects: Vec<ProjectRow>,
    /// The open card or project menu, with its items' words for this frame.
    pub menu: Option<MenuView>,
}

impl Panel {
    /// The pane's model for the core's current frame. With no frame yet,
    /// only the lanes' frame of headers is unknown, so the pane is empty.
    pub fn from_core(core: &mut Model) -> Panel {
        let Model {
            session,
            data,
            view,
        } = core;
        match data {
            Some(data) => build::build(session, data, view),
            None => Panel {
                view: view_of(view),
                ..Panel::default()
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
}
