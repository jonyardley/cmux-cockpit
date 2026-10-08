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
    badge_of, card_unread, chip_views, chips_for_density, detail_lines, faint_heading, icon_of,
    lane_name, size_ink, unread_text, view_of,
};
pub use editor::{EditorView, Field};

// The vocabulary a shell draws the panel with, so it needs none of the
// core's inner modules.
pub use crate::lanes::{Density, LANES, LaneKey};
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
/// A folded lane's chevron, and an open one's.
pub const FOLDED_MARK: &str = "▸";
pub const OPEN_MARK: &str = "▾";
/// A lane's square marker in its colour.
pub const LANE_MARK: &str = "■";
/// A status dot, and a hollow one.
pub const DOT: &str = "●";
pub const HOLLOW: &str = "○";

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
        /// The target's workspace id, so a click can draw it selected at once.
        ws_id: String,
        title: String,
        place: String,
    },
}

/// Needs you, which Next's pill carries (issue #281): how many sessions
/// wait on Jon, how long the oldest has, and where a tap on the pill goes.
/// Each waiting card stays in its lane and says so itself. A count of 0
/// when nothing waits.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, facet::Facet)]
pub struct Needs {
    pub count: usize,
    /// "3 need you", "1 needs you", or "" when nothing waits.
    pub label: String,
    /// "12m", the oldest ask's wait, or "" with nothing timed.
    pub wait: String,
    /// Whether the oldest has waited past the half hour.
    pub late: bool,
    /// The count's fill: amber while every waiting session asks and none
    /// is late, else clay. Clear when nothing waits.
    pub fill: Token,
    /// The pill's words, in the fill's text ink.
    pub ink: Token,
    /// The oldest waiting session Jon is not on, which the pill names and
    /// a tap on it reveals; None while the only one waiting is the one he
    /// is on.
    pub target: Option<NeedsTarget>,
}

/// A waiting session the pill names: its workspace and title.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, facet::Facet)]
pub struct NeedsTarget {
    pub ws_id: String,
    pub title: String,
}

/// Why a card waits on Jon: its leading edge, clay for Your turn and
/// amber for Asking, and the ink of its status line, which then says the
/// reason ("Asking: allow git push?").
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, facet::Facet)]
pub struct Waiting {
    pub edge: Token,
    pub ink: Token,
}

/// A project's badge: its SF Symbol on a tile of its colour, as the
/// sidebar's projectBadge draws it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, facet::Facet)]
pub struct Badge {
    /// The SF Symbol's name, "terminal" for Other.
    pub icon: String,
    /// The tile's colour from the table; None when it does not read as hex.
    pub color: Option<u32>,
}

/// A workspace's card.
#[derive(Debug, Clone, PartialEq, Serialize, facet::Facet)]
pub struct Card {
    pub ws_id: String,
    pub icon: Icon,
    pub title: String,
    /// Which of the sidebar's card shapes it takes in All, by its lane:
    /// full, compact or row. A Projects card has one shape of its own and
    /// says full.
    pub density: Density,
    /// Its project's badge, by the card's title (parts.ts glyph).
    pub badge: Badge,
    /// The unread count its badge shows, "" with none: none on a card
    /// while its Ready pill stands in (badgeCount), the plain count on a
    /// row, which has no Ready pill.
    pub unread: String,
    /// Ready: finished while Jon was elsewhere, with output unread; the
    /// green pill by the title. Never on a row, which has no pill.
    pub ready: bool,
    /// Pinned: the faint pin at the end of the title row.
    pub pinned: bool,
    /// The progress bar along the bottom, 0 to 1; None draws no bar.
    pub progress: Option<f64>,
    /// "· 3 helpers" after the status while subagent runs are live, else "".
    pub helpers: String,
    /// The status and its age, "Working 14m"; a row's age alone.
    pub status: String,
    pub status_ink: Token,
    /// How long the status has held, "12m", "" before anything says. The
    /// title row shows it only while `status_has_age` is false, so a card
    /// never reads two times. A row's status is its age, so on a row this
    /// is the same string and `status_has_age` holds while it says one.
    pub age: String,
    /// Whether the status line carries a time of its own.
    pub status_has_age: bool,
    /// "You: " and the last prompt, in lanes you come back to; else "".
    pub left_off: String,
    /// Its chips row: the size, the PR, the branch, the ports and, on a
    /// project card, Make project, as the sidebar's card of this kind
    /// shows them; empty for a row.
    pub chips: Vec<Chip>,
    /// The latest message, or what the waiting chat wants; on a waiting
    /// row, its reason ("Asking: allow git push?"), as a row's status is
    /// its age. Empty on a waiting full or compact card, whose status line
    /// says the reason.
    pub detail: String,
    /// The detail's ink: the waiting ink on a waiting row, else secondary.
    pub detail_ink: Token,
    /// How many detail lines it draws: two on a full card, else one.
    pub detail_lines: usize,
    /// Set while its session waits on Jon: the card keeps its place and
    /// draws the edge, its status line the reason. Its title row's age
    /// takes the same ink.
    pub waiting: Option<Waiting>,
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

/// What a chip is, so a shell can give each kind its own look: the
/// sidebar frames the size, PR, branch and port chips as quiet pills, sets
/// the diff size unframed and faint after the PR, and draws actions as
/// white buttons.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, facet::Facet)]
#[repr(u8)]
pub enum ChipKind {
    /// What answering the chat takes: "Quick", "Decide · 2".
    Size,
    /// The PR's number and state; on a compact card, its words.
    Pr,
    /// The PR's diff size, "+120 −8", after the PR.
    Diff,
    Branch,
    /// The first port and how many more, opening it on localhost.
    Port,
    /// Something to press: Make project.
    Action,
}

/// One chip: its pieces, a space apart.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, facet::Facet)]
pub struct Chip {
    pub kind: ChipKind,
    pub pieces: Vec<Piece>,
    /// It goes first when the line is too narrow: the branch, as the
    /// sidebar's branch chip gives way to the PR, ports and actions.
    pub gives_way: bool,
    /// Where a tap opens: the PR's page, a port on localhost; None for
    /// the rest, and for a PR with no link.
    pub url: Option<String>,
    /// Whether a tap acts rather than selecting the card: Make project.
    pub is_action: bool,
}

impl Chip {
    /// A chip of `kind` that opens nothing and does not act.
    pub(crate) fn new(kind: ChipKind, pieces: Vec<Piece>) -> Chip {
        Chip {
            kind,
            pieces,
            gives_way: false,
            url: None,
            is_action: false,
        }
    }

    /// An action chip: Make project.
    pub(crate) fn action(pieces: Vec<Piece>) -> Chip {
        Chip {
            is_action: true,
            ..Chip::new(ChipKind::Action, pieces)
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
#[derive(Debug, Clone, PartialEq, Serialize, facet::Facet)]
#[repr(u8)]
pub enum ProjectRow {
    Header(ProjectHead),
    Card(Card),
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
        /// Its SF Symbol's name, for the badge before its name.
        icon: String,
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
    /// Its SF Symbol's name, for the badge before its name.
    pub icon: String,
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

/// A row under a lane header: a card. An enum still, so the shells keep
/// one shape if a lane draws another kind of row again.
#[derive(Debug, Clone, PartialEq, Serialize, facet::Facet)]
#[repr(u8)]
pub enum Row {
    Card(Box<Card>),
}

impl Row {
    /// The row's card.
    pub fn card(&self) -> &Card {
        match self {
            Row::Card(c) => c,
        }
    }

    /// The workspace the row stands for.
    pub fn ws_id(&self) -> &str {
        &self.card().ws_id
    }

    /// Its state's place in the lane's sort.
    pub fn rank(&self) -> u8 {
        self.card().rank
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
#[derive(Debug, Clone, PartialEq, Serialize, facet::Facet)]
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
#[derive(Debug, Clone, Default, PartialEq, Serialize, facet::Facet)]
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
            ..
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
                ProjectRow::QuietHeader { .. } | ProjectRow::Editor(_) => None,
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

    /// The lanes' cards, top to bottom.
    fn lane_cards(&self) -> impl Iterator<Item = &Card> {
        self.lanes.iter().flat_map(|l| &l.rows).map(Row::card)
    }

    /// The cards the cursor moves between, top to bottom, by workspace id.
    pub fn card_ids(&self) -> Vec<&str> {
        self.lane_cards().map(|c| c.ws_id.as_str()).collect()
    }

    /// Whether `id`'s card waits on Jon.
    pub fn is_waiting(&self, id: &str) -> bool {
        self.lane_cards()
            .any(|c| c.ws_id == id && c.waiting.is_some())
    }

    /// Whether `id` is a card in a lane.
    pub fn is_lane_card(&self, id: &str) -> bool {
        self.lane_cards().any(|c| c.ws_id == id)
    }

    /// Whether the core will move `id`'s card: false for one that anchors
    /// another group, and for an id the pane does not show.
    pub fn movable(&self, id: &str) -> bool {
        self.lane_cards()
            .find(|c| c.ws_id == id)
            .is_some_and(|c| c.movable)
    }

    /// The lane `id`'s card sits in.
    pub fn lane_of(&self, id: &str) -> Option<LaneKey> {
        self.lanes
            .iter()
            .find(|l| l.rows.iter().any(|r| r.ws_id() == id))
            .map(|l| l.key)
    }

    /// A lane's rows top to bottom.
    pub fn lane_rows(&self, key: LaneKey) -> Vec<&Row> {
        self.lanes
            .iter()
            .filter(|l| l.key == key)
            .flat_map(|l| &l.rows)
            .collect()
    }
}
